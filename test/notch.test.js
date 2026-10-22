'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { isStatusItemHidden } = require('../src/main/notch');

// 13.6" MacBook Air (default scaling): 1470×956pt, menu bar 37pt, notch in the middle.
const air = { bounds: { x: 0, y: 0, width: 1470, height: 956 }, workArea: { x: 0, y: 37, width: 1470, height: 919 } };
// External monitor / pre-2021 Mac: 24pt menu bar, no notch.
const plain = { bounds: { x: 1470, y: 0, width: 2560, height: 1440 }, workArea: { x: 1470, y: 24, width: 2560, height: 1416 } };

test('icon to the right of the notch is visible', () => {
  assert.equal(isStatusItemHidden({ x: 1000, y: 0, width: 60, height: 37 }, air), false);
});
test('icon reported under / left of the notch is hidden', () => {
  assert.equal(isStatusItemHidden({ x: 720, y: 0, width: 60, height: 37 }, air), true);
  assert.equal(isStatusItemHidden({ x: 300, y: 0, width: 60, height: 37 }, air), true);
});
test('icon with no size is hidden', () => {
  assert.equal(isStatusItemHidden({ x: 0, y: 0, width: 0, height: 0 }, air), true);
});
test('no notch: anywhere in the menu bar is fine', () => {
  assert.equal(isStatusItemHidden({ x: 1470 + 900, y: 0, width: 60, height: 24 }, plain), false);
});
