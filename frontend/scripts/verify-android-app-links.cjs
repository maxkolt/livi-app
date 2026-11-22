#!/usr/bin/env node
// Check the merged release manifest or bundletool's manifest dump, not just source XML.
const fs = require('node:fs');
const assert = require('node:assert/strict');
const { AndroidConfig } = require('@expo/config-plugins');

async function main() {
  const [manifestPath, assetLinksPath, ...certificates] = process.argv.slice(2);
  assert(manifestPath && assetLinksPath && certificates.length,
    'Usage: node scripts/verify-android-app-links.cjs <release-manifest.xml> <assetlinks.json> <play-app-signing-sha256> [...]');
  const { manifest } = await AndroidConfig.Manifest.readAndroidManifestAsync(manifestPath);
  const packageName = 'com.kolt12max.livi';
  const domain = 'api.liviapp.com';
  assert.equal(manifest.$.package, packageName, 'Expected the production application ID');
  const application = manifest.application[0];
  assert.notEqual(application.$['android:debuggable'], 'true', 'A debug build is not a release');
  const activities = application.activity || [];
  const activityName = activity => activity.$['android:name'];
  const mainActivity = activities.find(activity => ['.MainActivity', `${packageName}.MainActivity`].includes(activityName(activity)));
  assert(mainActivity, 'MainActivity is missing');
  const publicFilters = activities.flatMap(activity =>
    (activity['intent-filter'] || []).filter(filter =>
      filter.action?.some(action => action.$['android:name'] === 'android.intent.action.VIEW') &&
      filter.category?.some(category => category.$['android:name'] === 'android.intent.category.BROWSABLE')
    ).map(filter => ({ activity, filter }))
  );
  assert.equal(publicFilters.length, 1, 'Release must expose only its verified invitation filter');
  const { activity, filter } = publicFilters[0];
  assert.equal(activity, mainActivity);
  assert.equal(filter.$?.['android:autoVerify'], 'true');
  assert(filter.category.some(category => category.$['android:name'] === 'android.intent.category.DEFAULT'));
  assert.equal(filter.data.length, 1);
  const data = filter.data[0].$;
  assert.equal(data['android:scheme'], 'https');
  assert.equal(data['android:host'], domain);
  assert.equal(data['android:pathPrefix'], '/invite/');
  for (const entry of activities) {
    for (const candidate of entry['intent-filter'] || []) {
      for (const item of candidate.data || []) {
        assert(!/^(livi|exp\+)/.test(item.$['android:scheme'] || ''), 'Custom/development scheme leaked into the release');
      }
    }
  }
  for (const name of ['IncomingCallActivity', 'OutgoingCallActivity']) {
    const entry = activities.find(candidate => ['.' + name, packageName + '.' + name].includes(activityName(candidate)));
    assert(entry, `${name} is missing`);
    assert.equal(entry.$['android:exported'], 'false', `${name} must remain internal`);
  }
  const statements = JSON.parse(fs.readFileSync(assetLinksPath, 'utf8'));
  const statement = statements.find(item =>
    item.relation?.includes('delegate_permission/common.handle_all_urls') &&
    item.target?.namespace === 'android_app' && item.target.package_name === packageName
  );
  assert(statement, 'Domain must delegate link handling to the production package');
  for (const fingerprint of certificates) {
    assert(statement.target.sha256_cert_fingerprints.includes(fingerprint.toUpperCase()),
      `Domain does not trust the requested signing certificate: ${fingerprint}`);
  }
  console.log(JSON.stringify({
    manifest: manifestPath, versionCode: manifest.$['android:versionCode'],
    publicAppLinks: [`https://${domain}/invite/`], customSchemes: [],
    internalCallActivities: 'preserved', trustedPlayCertificates: certificates.length,
  }, null, 2));
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
