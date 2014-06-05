/* -*- mode: espresso; espresso-indent-level: 2; indent-tabs-mode: nil -*- */
/* vim: set softtabstop=2 shiftwidth=2 tabstop=2 expandtab: */

"use strict";

var MorphologyPlot = function() {
  this.widgetID = this.registerInstance();
  this.registerSource();

  this.models = {};
  this.lines = {};
};

MorphologyPlot.prototype = {};
$.extend(MorphologyPlot.prototype, new InstanceRegistry());
$.extend(MorphologyPlot.prototype, new SkeletonSource());

MorphologyPlot.prototype.getName = function() {
  return "Morphology Plot " + this.widgetID;
};

MorphologyPlot.prototype.destroy = function() {
  this.unregisterInstance();
  this.unregisterSource();
  neuronNameService.unregister(this);
  
  Object.keys(this).forEach(function(key) { delete this[key]; }, this);
};

MorphologyPlot.prototype.update = function() {
    this.append(this.models);
};

MorphologyPlot.prototype.updateModels = function(models) {
  this.append(models);
};

MorphologyPlot.prototype.hasSkeleton = function(skeleton_id) {
    return skeleton_id in this.models;
};

/** Returns a clone of all skeleton models, keyed by skeleton ID. */
MorphologyPlot.prototype.getSelectedSkeletonModels = function() {
  return Object.keys(this.models).reduce((function(o, skid) {
    o[skid] = this.models[skid].clone();
    return o;
  }).bind(this), {});
};

MorphologyPlot.prototype.getSkeletonModels = function() {
    return Object.keys(this.models).reduce((function(o, skid) {
        o[skid] = this.models[skid].clone();
        return o;
    }).bind(this), {});
};

MorphologyPlot.prototype.highlight = function(skeleton_id) {
    // TODO
};

// TODO abstract from CircuitGraphPlot
MorphologyPlot.prototype.resize = function() {
  var now = new Date();
  // Overwrite request log if any
  this.last_request = now;

  setTimeout((function() {
    if (this.last_request && now === this.last_request) {
      delete this.last_request;
      this.draw();
    }
  }).bind(this), 1000);
};

MorphologyPlot.prototype.clear = function() {
   this.models = {}; 
   this.lines = {};
   this.clearGUI();
};

MorphologyPlot.prototype.clearGUI = function() {
  this.selected = {};
  $('#morphology_plot_div' + this.widgetID).empty();
};

MorphologyPlot.prototype.append = function(models) {
  var newIDs = {};
  Object.keys(models).forEach(function(skid) {
    var model = models[skid];
    if (model.selected) {
      if (!(skid in this.models)) newIDs[skid] = true;
      this.models[skid] = model.clone();
    } else {
      // Won't fail when not present
      delete this.models[skid];
      delete this.lines[skid];
    }
  }, this);

  var skeleton_ids = Object.keys(newIDs);

  if (0 === skeleton_ids.length) {
    // Update colors, names, etc.
    this.draw();
    return;
  }

  fetchCompactSkeletons(
      skeleton_ids,
      false,
      (function(skeleton_id, json) {
        this.lines[skeleton_id] = {nodes: json[1],
                                   connectors: json[3]};
      }).bind(this),
      (function(skeleton_id) {
        // Failed loading
        var model = this.models[skeleton_id];
        growlAlert("ERROR", "Failed to fetch " + model.baseName + ' #' + skeleton_id);
      }).bind(this),
      (function() {
        // Done loading all
        this._populateLines(skeleton_ids);
        neuronNameService.registerAll(this, models, this.draw.bind(this));
      }).bind(this));
};

MorphologyPlot.prototype.redraw = function() {
  this.mode =  $('#morphology_plot_buttons' + this.widgetID + '_function option:selected').text();
  this.center_mode = $('#morphology_plot_buttons' + this.widgetID + '_center option:selected').text();
  this.radius_increment = Number($('#morphology_plot_step' + this.widgetID).val());

  this._populateLines(Object.keys(this.models));

  this.draw();
};

MorphologyPlot.prototype._populateLines = function(skeleton_ids) {
  if (!this.mode) {
    this.redraw();
    return;
  }

  skeleton_ids.forEach(this._populateLine.bind(this));
};

MorphologyPlot.prototype._populateLine = function(skeleton_id) {
  var line = this.lines[skeleton_id],
      positions = line.nodes.reduce(function(o, row) {
        o[row[0]] = new THREE.Vector3(row[3], row[4], row[5]);
        return o;
      }, {}),
      arbor = new Arbor();
  // Populate arbor
  line.nodes.forEach(function(row) {
    if (row[1]) {
      arbor.edges[row[0]] = row[1];
    } else {
      arbor.root = row[0];
    }
  });
  var center = this._computeCenter(this.center_mode, arbor, positions, line.connectors);

  if ('Sholl analysis' === this.mode) {
    var distanceToCenterFn = function(node) {
      return center.distanceTo(positions[node]);
    };
    var sholl = arbor.sholl(this.radius_increment, distanceToCenterFn);
    line.x = sholl.radius;
    line.y = sholl.crossings;
    return;
  }

  if (0 === this.mode.indexOf('Radial density')) {
    var endsWith = function(s, suffix) {
      return -1 !== s.indexOf(suffix, s.length - suffix.length);
    }

    var ps = positions;

    if (endsWith(this.mode, 'ends')) {
      ps = arbor.findEndNodes().reduce(function(o, node) {
        o[node] = positions[node];
        return o;
      }, {});
    } else if (endsWith(this.mode, 'branch nodes')) {
      ps = arbor.findBranchNodes().reduce(function(o, node) {
        o[node] = positions[node];
        return o;
      }, {});
    } else if (endsWith(this.mode, 'input synapses')) {
      ps = line.connectors.reduce(function(o, row) {
        if (1 === row[2]) o[row[0]] = positions[row[0]];
        return o;
      }, {});
    } else if (endsWith(this.mode, 'output synapses')) {
      ps = line.connectors.reduce(function(o, row) {
        if (0 === row[2]) o[row[0]] = positions[row[0]];
        return o;
      }, {});
    }
    
    var fnCount;

    if (endsWith(this.mode, 'cable')) {
      // Approximate by assuming that parent and child fall within the same bin
      fnCount = function(node) {
        if (arbor.root === node) return 0;
        // distance from child to parent
        return positions[node].distanceTo(positions[arbor.edges[node]]);
      };
    } else {
      fnCount = function() { return 1; };
    }

    var density = arbor.radialDensity(center, this.radius_increment, ps, fnCount);
    line.x = density.bins;
    line.y = density.counts;
  }
};

MorphologyPlot.prototype._computeCenter = function(center_mode, arbor, positions, connectors) {
  if ('Root node' === center_mode) return positions[arbor.root];
  if ('Active node' === center_mode) return SkeletonAnnotations.getActiveNodeVector3();
  if ('First branch node' === center_mode) {
    var node = arbor.nextBranchNode(arbor.root);
    return positions[null === node ? arbor.root : node];
  }
  if ('Bounding box center' === center_mode) {
    var b = Object.keys(positions).reduce(function(b, node) {
      var v = positions[node];
      b.xMin = Math.min(b.xMin, v.x);
      b.xMax = Math.max(b.xMax, v.x);
      b.yMin = Math.min(b.yMin, v.y);
      b.yMax = Math.max(b.yMax, v.y);
      b.zMin = Math.min(b.zMin, v.z);
      b.zMax = Math.max(b.zMax, v.z);
      return b;
    }, {xMin: Number.MAX_VALUE,
        xMax: 0,
        yMin: Number.MAX_VALUE,
        yMax: 0,
        zMin: Number.MAX_VALUE,
        zMax: 0});
    return new THREE.Vector3((b.xMax - b.xMin) / 2,
                             (b.yMax - b.yMin) / 2,
                             (b.zMax - b.zMin) / 2);
  }
  if ('Average node position' === center_mode) {
    var nodes = Object.keys(positions),
        len = nodes.length,
        c = nodes.reduce(function(c, node) {
          var v = positions[node];
          c.x += v.x / len;
          c.y += v.y / len;
          c.z += v.z / len;
          return c;
        }, {x: 0, y: 0, z: 0});
    return new THREE.Vector3(c.x, c.y, c.z);
  }
  if ('Highest centrality node' === center_mode) {
    var c = arbor.betweennessCentrality(true),
        sorted = Object.keys(c).sort(function(a, b) {
          var c1 = c[a],
              c2 = c[b];
          return c1 === c2 ? 0 : (c1 > c2 ? 1 : -1);
        }),
        highest = sorted[Math.floor(sorted.length / 2)];
    return positions[highest];
  }
  if ('Highest signal flow centrality' === center_mode) {
    var io = connectors.reduce(function(o, row) {
      var a = o[row[2]], // row[2] is 0 for pre, 1 for post
          node = row[0],
          count = a[node];
      if (undefined === count) a[node] = 1;
      else a[node] = count + 1;
      return o;
    }, [{}, {}]); // 0 for pre, 1 for post
    var c = arbor.flowCentrality(io[0], io[1]),
        sorted = Object.keys(positions).sort(function(a, b) {
          var c1 = c[a],
              c2 = c[b];
          return c1 === c2 ? 0 : (c1 > c2 ? 1 : -1);
        }),
        highest = sorted[Math.floor(sorted.length / 2)],
        max = c[highest],
        identical = sorted.filter(function(node) {
          return max === c[node];
        });
    if (identical.length > 1) {
      // Pick the most central
      var bc = arbor.betweennessCentrality(true);
      identical.sort(function(a, b) {
        var c1 = bc[a],
            c2 = bc[b];
        // Sort descending
        return c1 == c2 ? 0 : (c1 < c2 ? 1 : -1);
      });
      highest = identical[0];
    }
    return positions[highest];
  }
};

MorphologyPlot.prototype.draw = function() {
  var containerID = '#morphology_plot_div' + this.widgetID,
      container = $(containerID);

  // Clear existing plot if any
  container.empty();

  // Dimensions and padding
  var margin = {top: 20, right: 20, bottom: 30, left: 40},
      width = container.width() - margin.left - margin.right,
      height = container.height() - margin.top - margin.bottom;

  var zip = function(xs, ys) {
    return xs.map(function(x, i) {
      return {x: x, y: ys[i]};
    });
  };

  // Package data
  var xMin = Number.MAX_VALUE,
      xMax = 0,
      yMin = Number.MAX_VALUE,
      yMax = 0,
      data = Object.keys(this.lines).map(function(id) {
        var line = this.lines[id];
        xMin = Math.min(xMin, d3.min(line.x));
        xMax = Math.max(xMax, d3.max(line.x));
        yMin = Math.min(yMin, d3.min(line.y));
        yMax = Math.max(yMax, d3.max(line.y));
        return {id: id,
                name: neuronNameService.getName(id),
                hex: '#' + this.models[id].color.getHexString(),
                xy: zip(line.x, line.y)};
      }, this);

  var step = $('#morphology_plot_step' + this.widgetID).val();

  // Define the ranges of the axes
  var xR = d3.scale.linear().domain(d3.extent([xMin, xMax])).nice().range([0, width]);
  var yR = d3.scale.linear().domain(d3.extent([yMin, yMax])).nice().range([height, 0]);

  // Define the data domains/axes
  var xAxis = d3.svg.axis().scale(xR)
                           .orient("bottom");
  var yAxis = d3.svg.axis().scale(yR)
                           .orient("left");

  var svg = d3.select(containerID).append("svg")
      .attr("id", "morphology_plot" + this.widgetID)
      .attr("width", width + margin.left + margin.right)
      .attr("height", height + margin.top + margin.bottom)
    .append("g")
      .attr("transform", "translate(" + margin.left + ", " + margin.top + ")");

  // Add an invisible layer to enable triggering zoom from anywhere, and panning
  svg.append("rect")
    .attr("width", width)
    .attr("height", height)
    .style("opacity", "0");

  // Create a line function
  var line = d3.svg.line()
      .interpolate("basis")
      .x(function(d) { return xR(d.x); })
      .y(function(d) { return yR(d.y); });

  // Create a 'g' group for each skeleton, containing the line
  var elems = svg.selectAll(".state").data(data).enter()
    .append("g")
    .append("path")
    .attr("class", "line")
    .attr("fill", "none")
    .attr("d", function(d) { return line(d.xy); })
    .style("stroke", function(d) { return d.hex; });

  // Insert the graphics for the axes (after the data, so that they draw on top)
  var xg = svg.append("g")
      .attr("class", "x axis")
      .attr("transform", "translate(0," + height + ")")
      .attr("fill", "none")
      .attr("stroke", "black")
      .style("shape-rendering", "crispEdges")
      .call(xAxis);
  xg.selectAll("text")
      .attr("fill", "black")
      .attr("stroke", "none");
  xg.append("text")
      .attr("x", width)
      .attr("y", -6)
      .attr("fill", "black")
      .attr("stroke", "none")
      .attr("font-family", "sans-serif")
      .attr("font-size", "11px")
      .style("text-anchor", "end")
      .text("distance (nm)");

  var yg = svg.append("g")
      .attr("class", "y axis")
      .attr("fill", "none")
      .attr("stroke", "black")
      .style("shape-rendering", "crispEdges")
      .call(yAxis);
  yg.selectAll("text")
      .attr("fill", "black")
      .attr("stroke", "none");
  yg.append("text")
      .attr("fill", "black")
      .attr("stroke", "none")
      .attr("transform", "rotate(-90)")
      .attr("font-family", "sans-serif")
      .attr("font-size", "11px")
      .attr("y", 6)
      .attr("dy", ".71em")
      .style("text-anchor", "end")
      .text("value");

  this.svg = svg;
};

MorphologyPlot.prototype.createCSV = function() {
  // Find minimum and maximum values in the X axis
  var skids = Object.keys(this.lines);
  if (0 === skids.length) return;

  var xs = skids.reduce((function(o, skid) {
    return this.lines[skid].x.reduce(function(o, v) {
      o[v] = true;
      return o;
    }, o);
  }).bind(this), {});

  var xAxis = Object.keys(xs).map(Number).sort(function(a, b) {
    return a === b ? 0 : (a < b ? -1 : 1);
  });

  var csv = [this.mode + ',' + xAxis.join(',')].concat(skids.map(
        function(skid) {
          var line = this.lines[skid],
              values = line.x.reduce(
                function(v, x, i) {
                  v[x] = line.y[i];
                  return v;
                }, {});
           return neuronNameService.getName(skid) + ',' + xAxis.map(
             function(x) {
               var v = values[x];
               return undefined === v ? 0 : v;
             }).join(',');
        }, this));
  return csv.join('\n');
};

MorphologyPlot.prototype.exportCSV = function() {
  var blob = new Blob([this.createCSV()], {type : 'text/plain'});
  saveAs(blob, this.mode.replace(/ /g, '_') + ".csv");
};

MorphologyPlot.prototype.exportSVG = function() {
  saveDivSVG('morphology_plot_div' + this.widgetID, this.mode.replace(/ /g, '_') + ".svg");
};
