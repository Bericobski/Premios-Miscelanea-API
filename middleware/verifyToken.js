const { auth } = require('../firebaseAdmin');

async function verifyToken(req, res, next) {
    const authHeader = req.headers.authorization || '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;

    if (!token) {
        return res.status(401).json({ error: 'Missing Authorization bearer token' });
    }

    try {
        const decoded = await auth.verifyIdToken(token);
        req.firebaseUser = { uid: decoded.uid, email: decoded.email };
        next();
    } catch (err) {
        res.status(401).json({ error: 'Invalid or expired token' });
    }
}

module.exports = verifyToken;
