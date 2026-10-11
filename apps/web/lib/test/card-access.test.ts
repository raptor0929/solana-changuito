import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { decideAccess } from '../shared-card.ts';

describe('who may buy with the shared card', () => {
  it('a member of the card network may', () => {
    assert.equal(decideAccess({ mock: false, cardNetwork: 'devnet', member: true }), 'ok');
  });

  it('anyone else is refused, however signed in they are', () => {
    assert.equal(decideAccess({ mock: false, cardNetwork: 'devnet', member: false }), 'not-member');
  });

  it('no card row means nobody can buy', () => {
    assert.equal(decideAccess({ mock: false, cardNetwork: undefined, member: true }), 'no-card');
  });

  it('the mock touches no card, so it is open to everyone', () => {
    assert.equal(decideAccess({ mock: true, cardNetwork: undefined, member: false }), 'mock');
    assert.equal(decideAccess({ mock: true, cardNetwork: 'devnet', member: false }), 'mock');
  });
});
