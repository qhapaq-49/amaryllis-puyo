'use strict';

var _pendingMessages = [];
var _evaluateScreenshot = null;
var _initDone = false;
var _initTimer = setTimeout(function () {
  if (!_initDone) self.postMessage({ type: 'init_error', message: 'WASM runtime initialization timed out' });
}, 15000);

var Module = {
  onRuntimeInitialized: function () {
    _initDone = true;
    clearTimeout(_initTimer);
    _evaluateScreenshot = Module.cwrap('evaluate_screenshot', 'string', ['string']);
    self.postMessage({ type: 'ready' });
    _pendingMessages.forEach(handleMessage);
    _pendingMessages = null;
  },
  onAbort: function (what) {
    self.postMessage({ type: 'init_error', message: 'WASM aborted: ' + String(what) });
  }
};

self.addEventListener('error', function (e) {
  self.postMessage({ type: 'init_error', message: e.message || String(e) });
});

function handleMessage(e) {
  var id = e.data.id;
  var input = e.data.input;
  try {
    var result = _evaluateScreenshot(input);
    self.postMessage({ id: id, result: result });
  } catch (err) {
    self.postMessage({ id: id, error: String(err) });
  }
}

self.onmessage = function (e) {
  if (_evaluateScreenshot) {
    handleMessage(e);
  } else {
    _pendingMessages.push(e);
  }
};

importScripts('screenshot_eval.js');
