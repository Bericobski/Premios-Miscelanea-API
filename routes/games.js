const express = require('express');
const pool = require('../db');
const verifyToken = require('../middleware/verifyToken');
const requireAdmin = require('../middleware/requireAdmin');
const { db } = require('../firebaseAdmin');

const router = express.Router();

const DEFAULT_LIMIT = 60;
const MAX_LIMIT = 200;

router.get('/', async (req, res) => {
    const limit = Math.min(parseInt(req.query.limit, 10) || DEFAULT_LIMIT, MAX_LIMIT);
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);

    // Optional ?genre=Adventure narrows both the page and the total.
    const genre = typeof req.query.genre === 'string' && req.query.genre.trim() ? req.query.genre.trim() : null;
    const where = genre ? 'WHERE genre = ?' : '';
    const filterParams = genre ? [genre] : [];
    // Optional ?random=true returns a random selection instead of the id order (fine for a few hundred rows).
    const orderBy = req.query.random === 'true' ? 'RAND()' : 'id ASC';

    const [rows] = await pool.query(
        `SELECT id, title, description, studio, genre, rating, cover_image AS coverImage, gallery, year
         FROM games ${where} ORDER BY ${orderBy} LIMIT ? OFFSET ?`,
        [...filterParams, limit, offset]
    );
    const [[{ total }]] = await pool.query(`SELECT COUNT(*) AS total FROM games ${where}`, filterParams);

    const games = rows.map((row) => ({
        ...row,
        gallery: row.gallery ? JSON.parse(row.gallery) : [],
    }));

    res.json({ games, total });
});

// Every game with only the text columns the admin catalog table shows (~7.8k rows, small payload).
router.get('/catalog', async (req, res) => {
    const [rows] = await pool.query('SELECT id, title, studio, year FROM games ORDER BY id ASC');
    res.json(rows);
});

// Distinct genres already in the catalog, for the add-game form's select.
router.get('/genres', async (req, res) => {
    const [rows] = await pool.query(
        "SELECT DISTINCT genre FROM games WHERE genre IS NOT NULL AND genre <> '' ORDER BY genre"
    );
    res.json(rows.map((row) => row.genre));
});

const URL_PATTERN = /^https?:\/\/\S+$/i;

// Validates the add-game body. Returns { values } or { error }.
function validateNewGame(body) {
    const text = (value) => (typeof value === 'string' ? value.trim() : '');
    const values = {
        title: text(body.title),
        studio: text(body.studio),
        genre: text(body.genre),
        description: text(body.description),
        coverImage: text(body.coverImage),
        year: Number(body.year),
        rating: Number(body.rating),
    };
    const maxYear = new Date().getFullYear() + 5;

    if (!values.title || values.title.length > 200) return { error: 'Title is required (max 200 characters)' };
    if (values.studio.length > 150) return { error: 'Studio must be at most 150 characters' };
    if (!values.genre || values.genre.length > 100) return { error: 'Genre is required (max 100 characters)' };
    if (!Number.isInteger(values.year) || values.year < 1950 || values.year > maxYear) {
        return { error: `Year must be between 1950 and ${maxYear}` };
    }
    if (!Number.isFinite(values.rating) || values.rating < 1 || values.rating > 5) {
        return { error: 'Rating must be between 1 and 5' };
    }
    if (values.coverImage && (values.coverImage.length > 500 || !URL_PATTERN.test(values.coverImage))) {
        return { error: 'Cover image must be an http(s) URL (max 500 characters)' };
    }
    if (values.description.length > 2000) return { error: 'Description must be at most 2000 characters' };

    values.rating = Math.round(values.rating * 10) / 10;
    return { values };
}

// Admin only: adds a new game to the catalog.
router.post('/', verifyToken, requireAdmin, async (req, res) => {
    const { values, error } = validateNewGame(req.body || {});
    if (error) {
        return res.status(400).json({ error });
    }

    const [result] = await pool.query(
        `INSERT INTO games (title, description, studio, genre, rating, cover_image, gallery, year)
         VALUES (?, ?, ?, ?, ?, ?, '[]', ?)`,
        [
            values.title,
            values.description || null,
            values.studio || null,
            values.genre,
            values.rating,
            values.coverImage || null,
            values.year,
        ]
    );

    const [rows] = await pool.query(
        `SELECT id, title, description, studio, genre, rating, cover_image AS coverImage, gallery, year
         FROM games WHERE id = ?`,
        [result.insertId]
    );
    const game = rows[0];
    res.status(201).json({ ...game, rating: Number(game.rating), gallery: [] });
});

// One full game, e.g. to open its page from the admin catalog table (which only has text columns).
// Declared after /catalog and /genres so those words are never taken as an id.
router.get('/:id', async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
        return res.status(400).json({ error: 'Invalid game id' });
    }

    const [rows] = await pool.query(
        `SELECT id, title, description, studio, genre, rating, cover_image AS coverImage, gallery, year
         FROM games WHERE id = ?`,
        [id]
    );
    if (rows.length === 0) {
        return res.status(404).json({ error: 'Game not found' });
    }
    const game = rows[0];
    res.json({ ...game, gallery: game.gallery ? JSON.parse(game.gallery) : [] });
});

// Admin only: deletes a game, its votes (MySQL) and its comments (Firestore).
// Other MySQL rows that point at the game (gallery, categories) go with it via ON DELETE CASCADE.
router.delete('/:id', verifyToken, requireAdmin, async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
        return res.status(400).json({ error: 'Invalid game id' });
    }

    const connection = await pool.getConnection();
    let votesDeleted;
    try {
        await connection.beginTransaction();
        const [voteResult] = await connection.query('DELETE FROM votes WHERE game_id = ?', [id]);
        const [gameResult] = await connection.query('DELETE FROM games WHERE id = ?', [id]);
        if (gameResult.affectedRows === 0) {
            await connection.rollback();
            return res.status(404).json({ error: 'Game not found' });
        }
        await connection.commit();
        votesDeleted = voteResult.affectedRows;
    } catch (err) {
        await connection.rollback();
        console.error('Failed to delete game', id, err);
        return res.status(500).json({ error: 'Could not delete the game' });
    } finally {
        connection.release();
    }

    // Comments (and the likes stored inside them) live in Firestore, outside the MySQL transaction.
    const result = { deleted: true, votesDeleted };
    try {
        const comments = await db.collection('gameComments').where('gameId', '==', id).get();
        const writer = db.bulkWriter();
        comments.docs.forEach((doc) => writer.delete(doc.ref));
        await writer.close();
        result.commentsDeleted = comments.size;
    } catch (err) {
        console.error('Game deleted but Firestore cleanup failed', id, err);
        result.commentsCleanup = 'failed';
    }
    res.json(result);
});

module.exports = router;
