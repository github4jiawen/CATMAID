# -*- coding: utf-8 -*-

import logging
import os
import re
import functools

from selenium import webdriver
from selenium.webdriver.common.by import By
from selenium.webdriver.common.keys import Keys
from selenium.webdriver.support.ui import WebDriverWait
import selenium.webdriver.support.expected_conditions as EC

from unittest import SkipTest

from django.conf import settings
from django.contrib.staticfiles.testing import StaticLiveServerTestCase

from catmaid.models import User, DataView, DataViewType

from guardian.utils import get_anonymous_user


logger = logging.getLogger(__name__)


def credentials_available():
    """Test if there are valid Saucelabs credentials set through environment
    variables.
    """
    username = os.environ.get("SAUCE_USERNAME")
    access_key = os.environ.get("SAUCE_ACCESS_KEY")
    # The username 'ur-username' and the access key 'ur-access-key' are default
    # values by Saucelabs that are set if no username or access key was provided
    return username not in (None, 'ur-username') and \
            access_key not in (None, 'ur-access-key')


def gui_tests_enabled():
    return settings.GUI_TESTS_ENABLED and \
            (not settings.GUI_TESTS_REMOTE or credentials_available())


def skipIfGUITestsDisabled(func):
    """Skip a test if no Saucelaubs credentials can be found.
    """
    @functools.wraps(func)
    def wrapper_decorator(*args, **kwargs):
        if gui_tests_enabled():
            return func(*args, **kwargs)
        raise SkipTest('GUI tests are not enabled')
    return wrapper_decorator


class BasicUITest(StaticLiveServerTestCase):
    """Test basic front-end elements and workflows, e.g. login/logout. Selenium
    is used for this. In CATMAID's default configuration, GUI tests are disabled
    to not interfer too much with console based test runs. They can be enabled
    by setting GUI_TESTS_ENABLED = True, which is also what is done in our CI
    tests. Additionally, for CI testing, GUI_TESTS_REMOTE is also set to true,
    which causes this test case to use a remote Selenium driver. This remote
    driver uses saucelabs.com to execute GUI tests on a virtual machine.
    """
    maxDiff = None

    @classmethod
    def create_test_data(cls):
        """Provide some basic model instances to get a running CATMAID front-end
        without fixtures.
        """
        cls.created_models = []
        cls.anon_user, created = User.objects.get_or_create(
                username='AnonymousUser', defaults={'email': 'anon@my.mail'})
        if created:
            cls.created_models.append(cls.anon_user)

        cls.user, created = User.objects.get_or_create(username='test',
                defaults={'email': 'test@my.mail'})
        cls.user.set_password('test')
        cls.user.save()
        if created:
            cls.created_models.append(cls.user)

        dvt, created = DataViewType.objects.get_or_create(
                code_type='project_list_data_view',
                defaults={'title': 'Project list'})
        if created:
            cls.created_models.append(dvt)

        dv, created = DataView.objects.get_or_create(title='Project list',
                data_view_type=dvt, is_default=True)
        if created:
            cls.created_models.append(dv)

    @classmethod
    def remove_test_data(cls):
        """Destroy all created data
        """
        for m in cls.created_models:
            m.delete()

    def setUp(self):
        """Set up Selenium driver if GUI_TESTS_ENABLED (which will be a remote
        driver of saucelabs.com if GUI_TESTS_REMOTE is true).
        """
        super().setUp()
        if gui_tests_enabled():
            if settings.GUI_TESTS_REMOTE:
                # Set up Travis + Sauce Labs configuration
                username = os.environ.get("SAUCE_USERNAME")
                access_key = os.environ.get("SAUCE_ACCESS_KEY")

                # Saucelab's linux platform only supports Chrome up to v48.
                # Until this is updated, we have to work with their Windows
                # platform to use Chrome >= v55.
                capabilities = {
                    "platform": "Windows 10",
                    "browserName": "chrome",
                    "version": "latest",
                    "captureHtml": True,
                    "extendedDebugging": True,
                    "webdriverRemoteQuietExceptions": False,
                    "tunnel-identifier": os.environ["TRAVIS_JOB_NUMBER"],
                    "name": f"Job: {os.environ['TRAVIS_JOB_NUMBER']} Commit {os.environ['TRAVIS_COMMIT']}",
                    "build": os.environ["TRAVIS_BUILD_NUMBER"],
                    "tags": [os.environ["TRAVIS_PYTHON_VERSION"], "CI"]
                }
                # This should be a HTTPS URL, but due to urllib3 being in use by
                # selenium < v4 we can't get this to work with the Selenium
                # server. More details here: https://travis-ci.community/t/8923
                hub_url = f"{username}:{access_key}@ondemand.saucelabs.com"
                self.selenium = webdriver.Remote(
                    desired_capabilities=capabilities,
                    command_executor=f"http://{hub_url}/wd/hub",
                )
            else:
                self.selenium = webdriver.Firefox()

            # Give browser a chance to load elements
            self.selenium.implicitly_wait(20)

    def tearDown(self):
        """Figure out if this test case was successful (based on
        http://stackoverflow.com/questions/4414234). In case of a remote GUI
        test, saucelabs.com is updated (which otherwise doesn't know if the
        whole test case was a success).
        """
        result = self.defaultTestResult()  # these 2 methods have no side effects
        self._feedErrorsToResult(result, self._outcome.errors)
        error = self.list2reason(result.errors)
        failure = self.list2reason(result.failures)
        ok = not error and not failure

        if gui_tests_enabled():
            if settings.GUI_TESTS_REMOTE:
                # Let saucelabs.com know about the outcome of this test
                id = self.selenium.session_id
                logger.info(f'Link to remote Selenium GUI test job: https://saucelabs.com/jobs/{id}')

                from sauceclient import SauceClient
                username = os.environ["SAUCE_USERNAME"]
                access_key = os.environ["SAUCE_ACCESS_KEY"]
                sauce_client = SauceClient(username, access_key)
                sauce_client.jobs.update_job(self.selenium.session_id, passed=ok)

            self.selenium.quit()

        super().tearDown()

    @classmethod
    def setUpClass(cls):
        """Create some test data that can be used during GUI testing. This is
        done before all tests are run.
        """
        cls.create_test_data()
        super().setUpClass()

    @classmethod
    def tearDownClass(cls):
        """Remove created test data after all tests are done.
        """
        cls.remove_test_data()
        super().tearDownClass()

    def list2reason(self, exc_list):
        if exc_list and exc_list[-1][0] is self:
            return exc_list[-1][1]

    def make_url(self, path):
        """Combine the test server URL with a relative path.
        """
        return self.live_server_url + path

    @skipIfGUITestsDisabled
    def test_home_page_login_logout(self):
        """Test if the test server is reachable, the index page can be parsed
        without syntax errors, has the correct page title and login/logout works
        as expected.
        """
        self.selenium.get(self.make_url("/"))

        # Make sure the browser doesn't see any syntax errors during loading.
        # These unfortunately fail silently otherwise.
        browser_log = self.selenium.get_log('browser')
        for log_entry in browser_log:
            self.assertIn('message', log_entry)
            if 'SyntaxError' in log_entry['message']:
                print(f"Syntax error: {log_entry['message']}")

                # If there is a syntax error, try to parse the message to load
                # the respective source file and print the relevant lines.
                r = re.search(r'^(.*)\s(\d+):\d+\sUncaught', log_entry['message'])
                if r:
                    url = r.group(1)
                    line = int(r.group(2))

                    if url and line:
                        self.selenium.get(url)
                        lines = self.selenium.page_source.splitlines()
                        print("Relevant source code:")
                        c = 2
                        for line_idx in range(max(0, line - c - 1), min(len(lines) - 1, line + c)):
                            print(f"{line_idx+1}: {lines[line_idx]}")

                # Let test fail
                self.assertNotIn('SyntaxError', log_entry['message'])

            # Fail on any severe errors that aren't expected. Expected are 403
            # errors for settings loading for the anonymous user if not linked
            # to any project.
            self.assertIn('level', log_entry)
            unexpected_error = 'SEVERE' in log_entry['level'] and \
                    '403 (Forbidden)' not in log_entry['message']
            if unexpected_error:
                self.assertNotIn('SEVERE', log_entry['level'], log_entry['message'])

        # Check title
        self.assertTrue("CATMAID" in self.selenium.title)

        # Wait for front-page to be loaded
        content = WebDriverWait(self.selenium, 100).until(
                EC.visibility_of_element_located((By.CSS_SELECTOR, '#data_view')))

        # Login
        account = WebDriverWait(self.selenium, 10).until(
                EC.visibility_of_element_located((By.CSS_SELECTOR, '#account')))
        password = WebDriverWait(self.selenium, 10).until(
                EC.visibility_of_element_located((By.CSS_SELECTOR, '#password')))

        login = WebDriverWait(self.selenium, 10).until(
                EC.visibility_of_element_located((By.CSS_SELECTOR, '#login')))

        account.send_keys("test")
        password.send_keys("test")
        login.send_keys(Keys.RETURN)

        logout = WebDriverWait(self.selenium, 100).until(
                EC.visibility_of_element_located((By.CSS_SELECTOR, 'a#logout')))
        self.assertTrue(logout.is_displayed(), "Logout button is displayed")
        login = WebDriverWait(self.selenium, 10).until(
                EC.invisibility_of_element_located((By.CSS_SELECTOR, 'a#login')))
        self.assertFalse(login.is_displayed(), "Login button is invisible")

        # Logout
        logout.send_keys(Keys.RETURN)
        logout = WebDriverWait(self.selenium, 10).until(
                EC.invisibility_of_element_located((By.CSS_SELECTOR, 'a#logout')))
        self.assertFalse(logout.is_displayed(), "Logout button is invisible")
        login = WebDriverWait(self.selenium, 10).until(
                EC.visibility_of_element_located((By.CSS_SELECTOR, 'a#login')))
        self.assertTrue(login.is_displayed(), "Login button is displayed")
