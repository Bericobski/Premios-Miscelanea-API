require('dotenv').config();

const fs = require('fs');
const path = require('path');
const pool = require('../db');

const SOURCE_JSON = path.join(
    __dirname,
    '..',
    '..',
    '..',
    'premios-miscelanea',
    'src',
    'assets',
    'data',
    'gamesBig.json'
);

// gamesBig.json carries no release year at all, so every imported row gets this fixed value.
const IMPORT_YEAR = 2026;
const BATCH_SIZE = 1000;

async function main() {
    const games = JSON.parse(fs.readFileSync(SOURCE_JSON, 'utf8'));

    const [[{ count }]] = await pool.query('SELECT COUNT(*) AS count FROM games');
    if (count > 0) {
        console.error(`Aborting: games table already has ${count} row(s). Refusing to risk duplicate/colliding ids.`);
        process.exitCode = 1;
        return;
    }

    let inserted = 0;
    for (let i = 0; i < games.length; i += BATCH_SIZE) {
        const batch = games.slice(i, i + BATCH_SIZE).map((game) => [
            game.id,
            game.title,
            game.description ?? null,
            game.studio ?? null,
            game.genre ?? null,
            game.rating ?? 0,
            game.coverImage ?? null,
            JSON.stringify(game.gallery ?? []),
            IMPORT_YEAR,
        ]);

        await pool.query(
            `INSERT INTO games (id, title, description, studio, genre, rating, cover_image, gallery, year)
             VALUES ?`,
            [batch]
        );

        inserted += batch.length;
        console.log(`Inserted ${inserted}/${games.length}`);
    }

    console.log(`Done. Imported ${inserted} games (year hardcoded to ${IMPORT_YEAR}).`);
}

main()
    .catch((err) => {
        console.error('Import failed:', err);
        process.exitCode = 1;
    })
    .finally(() => pool.end());
