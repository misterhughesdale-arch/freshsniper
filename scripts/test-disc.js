const crypto = require('crypto');

// Calculate CREATE discriminator
const hash = crypto.createHash('sha256').update('global:create').digest();
const disc = hash.slice(0, 8);

console.log('CREATE discriminator:', Array.from(disc));
console.log('Hex:', disc.toString('hex'));
console.log('As u64:', disc.readBigUInt64LE(0).toString());

// Expected from Python: 8576854823835016728

