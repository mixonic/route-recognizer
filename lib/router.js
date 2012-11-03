(function(exports) {

var specials = [
  '/', '.', '*', '+', '?', '|',
  '(', ')', '[', ']', '{', '}', '\\'
];

var escapeRegex = new RegExp('(\\' + specials.join('|\\') + ')', 'g');

// A Segment represents a segment in the original route description.
// Each Segment type provides an `eachChar` and `regex` method.
//
// The `eachChar` method invokes the callback with one or more character
// specifications. A character specification consumes one or more input
// characters.
//
// The `regex` method returns a regex fragment for the segment. If the
// segment is a dynamic of star segment, the regex fragment also includes
// a capture.
//
// A character specification contains:
//
// * `validChars`: a String with a list of all valid characters, or
// * `invalidChars`: a String with a list of all invalid characters
// * `repeat`: true if the character specification can repeat

function StaticSegment(string) { this.string = string; }
StaticSegment.prototype = {
  eachChar: function(callback) {
    var string = this.string, char;

    for (var i=0, l=string.length; i<l; i++) {
      char = string.charAt(i);
      callback({ validChars: char });
    }
  },

  regex: function() {
    return this.string.replace(escapeRegex, '\\$1');
  }
};

function DynamicSegment(name) { this.name = name; }
DynamicSegment.prototype = {
  eachChar: function(callback) {
    callback({ invalidChars: "/", repeat: true });
  },

  regex: function() {
    return "([^/]+)";
  }
};

function StarSegment(name) { this.name = name; }
StarSegment.prototype = {
  eachChar: function(callback) {
    callback({ invalidChars: "", repeat: true });
  },

  regex: function() {
    return "(.+)";
  }
};

function parse(route, handler, types) {
  // normalize route as not starting with a "/". Recognition will
  // also normalize.
  if (route.charAt(0) === "/") { route = route.substr(1); }

  var segments = route.split("/"), results = [];

  for (var i=0, l=segments.length; i<l; i++) {
    var segment = segments[i], match;

    if (match = segment.match(/^:([^\/]+)$/)) {
      results.push(new DynamicSegment(match[1]));
      handler.push(match[1]);
      types.dynamics++;
    } else if (match = segment.match(/^\*([^\/]+)$/)) {
      results.push(new StarSegment(match[1]));
      handler.push(match[1]);
      types.stars++;
    } else {
      results.push(new StaticSegment(segment));
      types.statics++;
    }
  }

  return results;
}

// A State has a character specification and (`charSpec`) and a list of possible
// subsequent states (`nextStates`).
//
// If a State is an accepting state, it will also have several additional
// properties:
//
// * `regex`: A regular expression that is used to extract parameters from paths
//   that reached this accepting state.
// * `endpoints`: Information on how to convert the list of captures into calls
//   to registered handlers with the specified parameters
// * `types`: How many static, dynamic or star segments in this route. Used to
//   decide which route to use if multiple registered routes match a path.
//
// Currently, State is implemented naively by looping over `nextStates` and
// comparing a character specification against a character. A more efficient
// implementation would use a hash of keys pointing at one or more next states.

function State(charSpec) {
  this.charSpec = charSpec;
  this.nextStates = [];
}

State.prototype = {
  get: function(charSpec) {
    var nextStates = this.nextStates;

    for (var i=0, l=nextStates.length; i<l; i++) {
      var child = nextStates[i];

      var isEqual = child.charSpec.validChars === charSpec.validChars;
      isEqual = isEqual && child.charSpec.invalidChars === charSpec.invalidChars;

      if (isEqual) { return child; }
    }
  },

  put: function(charSpec) {
    var state;

    // If the character specification already exists in a child of the current
    // state, just return that state.
    if (state = this.get(charSpec)) { return state; }

    // Make a new state for the character spec
    state = new State(charSpec);

    // Insert the new state as a child of the current state
    this.nextStates.push(state);

    // If this character specification repeats, insert the new state as a child
    // of itself. Note that this will not trigger an infinite loop because each
    // transition during recognition consumes a character.
    if (charSpec.repeat) {
      state.nextStates.push(state);
    }

    // Return the new state
    return state;
  },

  // Find a list of child states matching the next character
  match: function(char) {
    var nextStates = this.nextStates, child, charSpec, chars;

    var returned = [];

    for (var i=0, l=nextStates.length; i<l; i++) {
      child = nextStates[i];
      charSpec = child.charSpec;

      if (chars = charSpec.validChars) {
        if (chars.indexOf(char) !== -1) { returned.push(child); }
      } else if (chars = charSpec.invalidChars) {
        if (chars.indexOf(char) === -1) { returned.push(child); }
      }
    }

    return returned;
  }
};

// This is a somewhat naive strategy, but should work in a lot of cases
// A better strategy would properly resolve /posts/:id/new and /posts/edit/:id
function sortSolutions(states) {
  return states.sort(function(a, b) {
    if (a.types.stars !== b.types.stars) { return a.types.stars - b.types.stars; }
    if (a.types.dynamics !== b.types.dynamics) { return a.types.dynamics - b.types.dynamics; }
    if (a.types.statics !== b.types.statics) { return a.types.statics - b.types.statics; }

    return 0;
  });
}

function recognizeChar(states, char) {
  var nextStates = [];

  for (var i=0, l=states.length; i<l; i++) {
    var state = states[i];

    nextStates = nextStates.concat(state.match(char));
  }

  return nextStates;
}

function endpoint(state, path) {
  var endpoints = state.endpoints, regex = state.regex;
  var captures = path.match(regex), currentCapture = 1;
  var result = [];

  for (var i=0, l=endpoints.length; i<l; i++) {
    var endpoint = endpoints[i], names = endpoint.names, params = {};

    for (var j=0, m=names.length; j<m; j++) {
      params[names[j]] = captures[currentCapture++];
    }

    result.push({ endpoint: endpoint.endpoint, params: params });
  }

  return result;
}

function addSegment(currentState, segment) {
  segment.eachChar(function(char) {
    var state;

    currentState = currentState.put(char);
  });

  return currentState;
}

// The main interface

var Router = exports.Router = function() {
  this.rootState = new State();
};

Router.prototype = {
  add: function(routes) {
    var currentState = this.rootState, regex = "^",
        types = { statics: 0, dynamics: 0, stars: 0 },
        endpoints = [];

    for (var i=0, l=routes.length; i<l; i++) {
      var route = routes[i], names = [];
      var segments = parse(route.path, names, types);

      for (var j=0, m=segments.length; j<m; j++) {
        var segment = segments[j];

        // Add a "/" for the new segment
        currentState = currentState.put({ validChars: "/" });
        regex += "/";

        // Add a representation of the segment to the NFA and regex
        currentState = addSegment(currentState, segment);
        regex += segment.regex();
      }

      endpoints.push({ endpoint: route.endpoint, names: names });
    }

    currentState.endpoints = endpoints;
    currentState.regex = new RegExp(regex + "$");
    currentState.types = types;
  },

  recognize: function(path) {
    var states = [ this.rootState ];

    if (path.charAt(0) !== "/") { path = "/" + path; }

    for (var i=0, l=path.length; i<l; i++) {
      states = recognizeChar(states, path.charAt(i));
      if (!states.length) { break; }
    }

    states = sortSolutions(states);

    var state = states[0];

    if (state && state.endpoints) {
      return endpoint(state, path);
    }
  }
};

})(window);