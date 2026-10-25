const { auth } = require('../firebaseAdmin');

async function verifyToken(req, res, next) {
    const authHeader = req.headers.authorization || '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;

    if (!token) {
        return res.status(401).json({ error: 'Missing Authorization bearer token' });
    }

    try {
        const decoded = await auth.verifyIdToken(token);
        req.firebaseUser = {
            uid: decoded.uid,
            email: decoded.email,
            // 'password' for email/password accounts, 'google.com' for Google sign-in.
            signInProvider: decoded.firebase && decoded.firebase.sign_in_provider,
        };
        next();
    } catch (err) {
        res.status(401).json({ error: 'Invalid or expired token' });
    }
}

module.exports = verifyToken;
