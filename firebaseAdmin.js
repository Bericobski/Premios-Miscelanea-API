const path = require('path');
const { initializeApp, cert } = require('firebase-admin/app');
const { getAuth } = require('firebase-admin/auth');
const { getFirestore } = require('firebase-admin/firestore');

const serviceAccount = require(path.resolve(process.env.FIREBASE_SERVICE_ACCOUNT_PATH));

const app = initializeApp({
    credential: cert(serviceAccount),
});

module.exports = {
    auth: getAuth(app),
    db: getFirestore(app),
};
