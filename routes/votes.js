const express = require('express');
const pool = require('../db');
const verifyToken = require('../middleware/verifyToken');
const requireAdmin = require('../middleware/requireAdmin');

const router = express.Router();

// The voter is always resolved from the verified Firebase token, never from the request body.
async function getUserId(firebaseUid) {
    const [rows] = await pool.query('SELECT id FROM users WHERE firebase_uid = ?', [firebaseUid]);
    return rows.length > 0 ? rows[0].id : null;
}

function isPositiveInt(value) {
    return Number.isInteger(value) && value > 0;
}

// One vote per user per award category: voting again in the same category
// (even for another game) replaces the previous vote thanks to the
// PRIMARY KEY (user_id, category_id) on the votes table.
router.post('/', verifyToken, async (req, res) => {
    const gameId = Number(req.body.gameId);
    const categoryId = Number(req.body.categoryId);

    if (!isPositiveInt(gameId) || !isPositiveInt(categoryId)) {
        return res.status(400).json({ error: 'gameId and categoryId must be positive integers' });
    }

    const userId = await getUserId(req.firebaseUser.uid);
    if (!userId) {
        return res.status(404).json({ error: 'User not provisioned yet' });
    }

    const [categoryRows] = await pool.query(
        'SELECT id FROM award_categories WHERE id = ? AND is_active = 1',
        [categoryId]
    );
    if (categoryRows.length === 0) {
        return res.status(404).json({ error: 'Award category not found' });
    }

    const [gameRows] = await pool.query('SELECT id FROM games WHERE id = ?', [gameId]);
    if (gameRows.length === 0) {
        return res.status(404).json({ error: 'Game not found' });
    }

    await pool.query(
        `INSERT INTO votes (user_id, category_id, game_id, created_at)
         VALUES (?, ?, ?, NOW())
         ON DUPLICATE KEY UPDATE game_id = VALUES(game_id), created_at = NOW()`,
        [userId, categoryId, gameId]
    );

    const [rows] = await pool.query(
        `SELECT user_id AS userId, category_id AS categoryId, game_id AS gameId, created_at AS createdAt
         FROM votes WHERE user_id = ? AND category_id = ?`,
        [userId, categoryId]
    );
    res.status(201).json(rows[0]);
});

router.get('/me', verifyToken, async (req, res) => {
    const userId = await getUserId(req.firebaseUser.uid);
    if (!userId) {
        return res.status(404).json({ error: 'User not provisioned yet' });
    }

    const [rows] = await pool.query(
        `SELECT user_id AS userId, category_id AS categoryId, game_id AS gameId, created_at AS createdAt
         FROM votes WHERE user_id = ?`,
        [userId]
    );
    res.json(rows);
});

// The signed-in user's votes with the full game and the award category name,
// newest first. Used by the user profile page.
router.get('/me/games', verifyToken, async (req, res) => {
    const userId = await getUserId(req.firebaseUser.uid);
    if (!userId) {
        return res.status(404).json({ error: 'User not provisioned yet' });
    }

    const [rows] = await pool.query(
        `SELECT v.category_id AS categoryId, ac.name AS categoryName, v.created_at AS createdAt,
                g.id, g.title, g.description, g.studio, g.genre, g.rating,
                g.cover_image AS coverImage, g.gallery, g.year
         FROM votes v
         JOIN games g ON g.id = v.game_id
         JOIN award_categories ac ON ac.id = v.category_id
         WHERE v.user_id = ?
         ORDER BY v.created_at DESC`,
        [userId]
    );

    res.json(
        rows.map(({ categoryId, categoryName, createdAt, ...game }) => ({
            categoryId,
            categoryName,
            createdAt,
            game: { ...game, gallery: game.gallery ? JSON.parse(game.gallery) : [] },
        }))
    );
});

// Vote totals per game, most voted first. Only games with at least one vote are
// returned. Without ?categoryId it counts votes from every category (the "All" view).
router.get('/stats', verifyToken, requireAdmin, async (req, res) => {
    const hasCategory = req.query.categoryId !== undefined;
    const categoryId = Number(req.query.categoryId);

    if (hasCategory && !isPositiveInt(categoryId)) {
        return res.status(400).json({ error: 'categoryId must be a positive integer' });
    }

    const [rows] = await pool.query(
        `SELECT g.id AS gameId, g.title, g.cover_image AS coverImage, COUNT(*) AS votes
         FROM votes v
         JOIN games g ON g.id = v.game_id
         ${hasCategory ? 'WHERE v.category_id = ?' : ''}
         GROUP BY g.id, g.title, g.cover_image
         ORDER BY votes DESC, g.title ASC`,
        hasCategory ? [categoryId] : []
    );
    res.json(rows.map((row) => ({ ...row, votes: Number(row.votes) })));
});

module.exports = router;
