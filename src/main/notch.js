'use strict';
/**
 * Is a macOS menu-bar (status) item hidden?
 * On screens with a camera notch the menu bar is ~37pt tall instead of 24pt, and status items
 * live only to the right of the notch. macOS silently hides items that don't fit there, so an
 * item reported left of the notch (or with no size) is not visible to the user.
 * Pure function so it can be unit-tested without Electron.
 */
function isStatusItemHidden(bounds, display) {
  if (!bounds || !bounds.width || !bounds.height) return true;
  const menuBarHeight = display.workArea.y - display.bounds.y;
  const notched = menuBarHeight >= 30;
  if (!notched) return false;
  const center = bounds.x + bounds.width / 2 - display.bounds.x;
  return center < display.bounds.width / 2 + 100; // notch is ~200pt wide, centred
}

module.exports = { isStatusItemHidden };
