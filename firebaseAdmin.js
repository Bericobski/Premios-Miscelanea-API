const path = require('path');
const { initializeApp, cert } = require('firebase-admin/app');
const { getAuth } = require('firebase-admin/auth');
const { getFirestore } = require('firebase-admin/firestore');

// On Vercel the key's JSON is pasted into FIREBASE_SERVICE_ACCOUNT (there are no secret files there);
// locally it is read from the file at FIREBASE_SERVICE_ACCOUNT_PATH.
const serviceAccount = process.env.FIREBASE_SERVICE_ACCOUNT
    ? JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)
    : require(path.resolve(process.env.FIREBASE_SERVICE_ACCOUNT_PATH));

const app = initializeApp({
    credential: cert(serviceAccount),
});

module.exports = {
    auth: getAuth(app),
    db: getFirestore(app),
};
