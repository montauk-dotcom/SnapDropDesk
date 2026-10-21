'use strict';
// Ad-hoc code signature for macOS builds. Without any signature Apple Silicon refuses to
// launch the app; ad-hoc signing needs no Apple Developer account.
const { execFileSync } = require('child_process');
const path = require('path');

exports.default = async function afterPack(ctx) {
  if (ctx.electronPlatformName !== 'darwin') return;
  const app = path.join(ctx.appOutDir, `${ctx.packager.appInfo.productFilename}.app`);
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', app], { stdio: 'inherit' });
};
