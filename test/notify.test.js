const { test } = require('node:test');
const assert = require('node:assert/strict');

const { shouldAlert, maskEmail } = require('../lib/notify');

test('shouldAlert: fires at half or more failures', () => {
  assert.equal(shouldAlert({ failed: 8, total: 15 }), true);   // ceil(15/2)=8
  assert.equal(shouldAlert({ failed: 7, total: 15 }), false);
  assert.equal(shouldAlert({ failed: 15, total: 15 }), true);
  assert.equal(shouldAlert({ failed: 1, total: 2 }), true);
  assert.equal(shouldAlert({ failed: 0, total: 15 }), false);
});

test('shouldAlert: rejects degenerate inputs', () => {
  assert.equal(shouldAlert({ failed: 0, total: 0 }), false);
  assert.equal(shouldAlert({ failed: NaN, total: 15 }), false);
  assert.equal(shouldAlert({ failed: 5, total: NaN }), false);
});

test('maskEmail never leaks more than the first character of the local part', () => {
  assert.equal(maskEmail('someone@example.com'), 's***@example.com');
  assert.equal(maskEmail('a@b.co'), 'a***@b.co');
  assert.equal(maskEmail('not-an-email'), '***');
});
