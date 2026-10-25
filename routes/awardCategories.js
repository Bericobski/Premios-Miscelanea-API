const express = require('express');
const pool = require('../db');

const router = express.Router();

router.get('/', async (req, res) => {
    const [rows] = await pool.query(
        'SELECT id, name FROM award_categories WHERE is_active = 1'
    );
    res.json(rows);
});

module.exports = router;
