var fs = require('fs');
var pack = require('./package.json');

var archPath = ['node', 'v' + process.versions.modules, process.platform, process.arch].join('-');
var binding = require('./build/debug/v' + [pack.version, archPath, 'debug.node'].join('/'));

function getInjectedScript(name) {
  return runScript(fs.readFileSync(require.resolve('./InjectedScript/' + name + '.js')));
}

runScript(
  'ToggleMirrorCache = (function(backup) {' +
    'var toggle = function() {};' +
    'toggle.backup = backup;' +
    'return toggle' +
  '})(ToggleMirrorCache)'
);

var DebuggerScript = getInjectedScript('DebuggerScript');
var JavaScriptCallFrame = getInjectedScript('JavaScriptCallFrame')(binding);
var InjectedScriptHost = getInjectedScript('InjectedScriptHost')(binding, DebuggerScript);
var InjectedScript = getInjectedScript('InjectedScriptSource')(InjectedScriptHost, global, process.pid);

runScript('ToggleMirrorCache = ToggleMirrorCache.backup');

var proto = runScript('DebugCommandProcessor.prototype');
var origProcess = proto.processDebugJSONRequest;

var v8DebugKey = '--v8-debug-key--';
var eventId = 0;

var commands = {};

exports = module.exports = {
  enabled: false,
  enable: enable,
  disable: disable,
  call: call,
  binding: binding,
  runScript: runScript,
  emitEvent: emitEvent,
  sendCommand: sendCommand,
  wrapCallFrames: wrapCallFrames,
  releaseObject: releaseObject,
  releaseObjectGroup, releaseObjectGroup,
  registerCommand: registerCommand,
  unregisterCommand: unregisterCommand,
  setPauseOnNextStatement: setPauseOnNextStatement,
  DebuggerScript: DebuggerScript,
  InjectedScript: InjectedScript,
  InjectedScriptHost: InjectedScriptHost,
  JavaScriptCallFrame: JavaScriptCallFrame
};

function processDebugJSONRequest(req) {
  return overrideProcessRequest.call(this, req) || origProcess.call(this, req);
}

function overrideProcessRequest(json) {
  var req;  // Current req.
  var res;  // Generated res.

  try {
    try {
      // Convert the JSON string to an object.
      req = JSON.parse(json);

      var handle = commands[req.command];

      if (!handle) return;

      var async = handle.async;

      // Create an initial res.
      res = this.createResponse(req);

      if (req.arguments) {
        var args = req.arguments;
        if (async && args.asyncResponse) {
          return JSON.stringify(args.asyncResponse);
        }
        if (typeof args.maxStringLength !== 'undefined') {
          res.setOption('maxStringLength', args.maxStringLength);
        }
      }

      InjectedScriptHost.execState = this.exec_state_;

      if (async) {
        handle.func.call(this, req, res, function(error) {
          sendCommand(req.command, { asyncResponse: error || res });
        });
        InjectedScriptHost.execState = null;
        return '{"seq":0,"type":"res","success":true}';
      }

      handle.func.call(this, req, res);
      InjectedScriptHost.execState = null;
    } catch (e) {
      // If there is no res object created one (without command).
      if (!res) res = this.createResponse();
      res.success = false;
      res.message = e.stack;
    }

    // Return the res as a JSON encoded string.
    try {
      if (typeof res.running !== 'undefined') {
        // Response controls running state.
        this.running_ = res.running;
      }
      res.running = this.running_;
      return JSON.stringify(res);
    } catch (e) {
      // Failed to generate res - return generic error.
      return '{"seq":' + res.seq + ',' +
              '"request_seq":' + req.seq + ',' +
              '"type":"response",' +
              '"success":false,' +
              '"message":"Internal error: ' + e.stack + '"}';
    }
  } catch (e) {
    // Failed in one of the catch blocks above - most generic error.
    return '{"seq":0,"type":"response","success":false,"message":"' + e.stack + '"}';
  }
}

function enable() {
  if (exports.enabled) return;

  // We need to share security token between current and debug context to
  // get access to evaluation functions
  binding.shareSecurityToken();

  proto.processDebugJSONRequest = processDebugJSONRequest;

  exports.enabled = true;
}

function disable() {
  if (!exports.enabled) return;
  commands = {};
  binding.unshareSecurityToken();
  proto.processDebugJSONRequest = origProcess;
  exports.enabled = false;
}

function wrapCallFrames(execState, maximumLimit, scopeDetails) {
  var scopeBits = 2;

  if (maximumLimit < 0) throw new Error('Incorrect stack trace limit.');
  var data = (maximumLimit << scopeBits) | scopeDetails;
  var currentCallFrame = DebuggerScript.currentCallFrame(execState, data);
  if (!currentCallFrame) return;

  return new JavaScriptCallFrame(currentCallFrame);
}

function setPauseOnNextStatement(pause) {
  binding.setPauseOnNextStatement(pause === true);
}

function registerCommand(command, func, async) {
  commands[command] = { func: func, async: async };
}

function unregisterCommand(command) {
  commands[command] = null;
}

function sendCommand(command, args) {
  binding.sendCommand(JSON.stringify({
    seq: 0,
    type: 'request',
    command: command,
    arguments: args
  }));
}

function emitEvent(event, body) {
  var tmpCommand = v8DebugKey + eventId++;
  registerCommand(tmpCommand, function(req, res) {
    res.type = 'event';
    res.event = event;
    res.command = undefined;
    res.request_seq = undefined;
    unregisterCommand(tmpCommand);
    if (typeof body === 'function') {
      InjectedScriptHost.execState = this.exec_state_;
      try {
        body.call(this, res);
      } finally {
        InjectedScriptHost.execState = null;
      }
    } else {
      res.body = body || {};
    }
  });
  sendCommand(tmpCommand, {});
}

function runScript(script) {
  return binding.runScript(script);
}

function call(func) {
  return binding.call(func);
}

function releaseObject(name) {
  return InjectedScriptHost.releaseObject(name);
}

function releaseObjectGroup(name) {
  return InjectedScriptHost.releaseObjectGroup(name);
}
