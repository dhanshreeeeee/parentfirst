// Generate a VAPID keypair to pin in the host's environment variables.
// Run: npm run vapid   — then paste both values into Render → Environment.
import webpush from 'web-push';
const k = webpush.generateVAPIDKeys();
console.log('\nSet these two on your host. They must NEVER change after people');
console.log('subscribe — new keys silently invalidate every existing subscription.\n');
console.log('  VAPID_PUBLIC=' + k.publicKey);
console.log('  VAPID_PRIVATE=' + k.privateKey);
console.log('\nKeep VAPID_PRIVATE secret; treat it like a password.\n');
