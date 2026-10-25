const pool = require('../db');

// Must run after verifyToken: relies on req.firebaseUser being set.
async function requireAdmin(req, res, next) {
    try {
        const [rows] = await pool.query('SELECT role FROM users WHERE firebase_uid = ?', [req.firebaseUser.uid]);
        if (rows.length === 0 || rows[0].role !== 'ADMIN') {
            return res.status(403).json({ error: 'Admin only' });
        }
        next();
    } catch (err) {
        res.status(500).json({ error: 'Could not verify admin role' });
    }
}

module.exports = requireAdmin;
