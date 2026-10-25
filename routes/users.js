const express = require('express');
const pool = require('../db');
const { FieldValue } = require('firebase-admin/firestore');
const { auth, db } = require('../firebaseAdmin');
const verifyToken = require('../middleware/verifyToken');
const requireAdmin = require('../middleware/requireAdmin');

const router = express.Router();

const SELECT_PROFILE = `
    SELECT id, firebase_uid AS firebaseUid, name, surename, nickname, email,
           profile_picture AS profilePicture, bio, role
    FROM users
`;

function deriveNameParts(displayName) {
    const trimmed = (displayName || '').trim();
    if (!trimmed) return { name: 'User', surename: '' };
    const parts = trimmed.split(/\s+/);
    if (parts.length === 1) return { name: parts[0], surename: '' };
    return { name: parts.slice(0, -1).join(' '), surename: parts[parts.length - 1] };
}

function baseNicknameFromEmail(email) {
    return (email || 'user').split('@')[0];
}

async function insertUserWithUniqueNickname({ firebaseUid, name, surename, email, profilePicture }) {
    const base = baseNicknameFromEmail(email);
    for (let attempt = 0; attempt < 20; attempt++) {
        const nickname = attempt === 0 ? base : `${base}${attempt + 1}`;
        try {
            const [result] = await pool.query(
                `INSERT INTO users (firebase_uid, name, surename, nickname, email, profile_picture, bio, role)
                 VALUES (?, ?, ?, ?, ?, ?, NULL, 'USER')`,
                [firebaseUid, name, surename, nickname, email, profilePicture]
            );
            return result.insertId;
        } catch (err) {
            if (err.code === 'ER_DUP_ENTRY' && err.sqlMessage && err.sqlMessage.includes('nickname')) {
                continue;
            }
            throw err;
        }
    }
    throw new Error('Could not generate a unique nickname');
}

router.post('/', verifyToken, async (req, res) => {
    const { uid, email: tokenEmail } = req.firebaseUser;
    const { displayName, email, photoURL } = req.body;

    const [existingRows] = await pool.query(`${SELECT_PROFILE} WHERE firebase_uid = ?`, [uid]);
    if (existingRows.length > 0) {
        return res.json(existingRows[0]);
    }

    const { name, surename } = deriveNameParts(displayName);
    const userId = await insertUserWithUniqueNickname({
        firebaseUid: uid,
        name,
        surename,
        email: email || tokenEmail,
        profilePicture: photoURL || null,
    });

    const [rows] = await pool.query(`${SELECT_PROFILE} WHERE id = ?`, [userId]);
    res.status(201).json(rows[0]);
});

router.get('/me', verifyToken, async (req, res) => {
    const [rows] = await pool.query(`${SELECT_PROFILE} WHERE firebase_uid = ?`, [req.firebaseUser.uid]);
    if (rows.length === 0) {
        return res.status(404).json({ error: 'User not provisioned yet' });
    }
    res.json(rows[0]);
});

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const NICKNAME_PATTERN = /^[A-Za-z0-9._-]+$/;

// Validates the editable profile fields. Returns { values } or { error }.
function validateProfileUpdate(body) {
    const text = (value) => (typeof value === 'string' ? value.trim() : '');
    const values = {
        name: text(body.name),
        surename: text(body.surename),
        nickname: text(body.nickname),
        email: text(body.email).toLowerCase(),
        bio: text(body.bio),
    };

    if (!values.name || values.name.length > 100) return { error: 'Name is required (max 100 characters)' };
    if (values.surename.length > 100) return { error: 'Surname must be at most 100 characters' };
    if (!values.nickname || values.nickname.length > 100 || !NICKNAME_PATTERN.test(values.nickname)) {
        return { error: 'Nickname is required and may only contain letters, numbers, dots, dashes and underscores' };
    }
    if (!EMAIL_PATTERN.test(values.email) || values.email.length > 255) return { error: 'Enter a valid email address' };
    if (values.bio.length > 500) return { error: 'Bio must be at most 500 characters' };

    return { values };
}

const ROLES = ['ADMIN', 'USER'];
const MIN_SEARCH_LENGTH = 3;

// Admin search: users whose nickname contains ?nickname (min 3 chars), optionally limited to ?roles=ADMIN,USER.
router.get('/', verifyToken, requireAdmin, async (req, res) => {
    const nickname = typeof req.query.nickname === 'string' ? req.query.nickname.trim() : '';
    if (nickname.length < MIN_SEARCH_LENGTH) {
        return res.status(400).json({ error: `Type at least ${MIN_SEARCH_LENGTH} characters of the nickname` });
    }

    const roles = typeof req.query.roles === 'string' && req.query.roles ? req.query.roles.split(',') : [];
    if (roles.some((role) => !ROLES.includes(role))) {
        return res.status(400).json({ error: 'roles may only contain ADMIN and USER' });
    }

    // Escape LIKE wildcards so "a_b" searches for a literal underscore.
    const pattern = `%${nickname.replace(/[\\%_]/g, '\\$&')}%`;
    let sql = `${SELECT_PROFILE} WHERE nickname LIKE ?`;
    const params = [pattern];
    if (roles.length > 0) {
        sql += ' AND role IN (?)';
        params.push(roles);
    }
    sql += ' ORDER BY nickname LIMIT 50';

    const [rows] = await pool.query(sql, params);
    res.json(rows);
});

// Removes the user's comments and their likes on other comments from Firestore.
async function deleteFirestoreActivity(uid) {
    const comments = db.collection('gameComments');
    const [ownComments, likedComments] = await Promise.all([
        comments.where('userFirebaseUid', '==', uid).get(),
        comments.where('likedByUserIds', 'array-contains', uid).get(),
    ]);

    const writer = db.bulkWriter();
    ownComments.docs.forEach((doc) => writer.delete(doc.ref));
    // Comments they wrote are deleted anyway, so only fix likes on other people's comments.
    const likesToRemove = likedComments.docs.filter((doc) => doc.get('userFirebaseUid') !== uid);
    likesToRemove.forEach((doc) =>
        writer.update(doc.ref, {
            likedByUserIds: FieldValue.arrayRemove(uid),
            likesTotal: FieldValue.increment(-1),
        })
    );
    await writer.close();

    return { commentsDeleted: ownComments.size, likesRemoved: likesToRemove.length };
}

// Admin delete: removes the user from MySQL (with their votes), Firebase Authentication and Firestore.
router.delete('/:id', verifyToken, requireAdmin, async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) {
        return res.status(400).json({ error: 'Invalid user id' });
    }

    const [targets] = await pool.query('SELECT firebase_uid AS firebaseUid FROM users WHERE id = ?', [id]);
    if (targets.length === 0) {
        return res.status(404).json({ error: 'User not found' });
    }
    const { firebaseUid } = targets[0];

    // MySQL and Firebase Auth are deleted together: if Firebase fails, the MySQL deletion is rolled back.
    const connection = await pool.getConnection();
    let votesDeleted;
    try {
        await connection.beginTransaction();
        const [voteResult] = await connection.query('DELETE FROM votes WHERE user_id = ?', [id]);
        votesDeleted = voteResult.affectedRows;
        await connection.query('DELETE FROM users WHERE id = ?', [id]);

        try {
            await auth.deleteUser(firebaseUid);
        } catch (err) {
            if (err.code !== 'auth/user-not-found') throw err;
        }

        await connection.commit();
    } catch (err) {
        await connection.rollback();
        console.error('Failed to delete user', id, err);
        return res.status(500).json({ error: 'Could not delete the user' });
    } finally {
        connection.release();
    }

    const result = { deleted: true, self: firebaseUid === req.firebaseUser.uid, votesDeleted };
    try {
        Object.assign(result, await deleteFirestoreActivity(firebaseUid));
    } catch (err) {
        console.error('User deleted but Firestore cleanup failed', firebaseUid, err);
        result.commentsCleanup = 'failed';
    }
    res.json(result);
});

// Edit the signed-in user's own profile. Role and firebase_uid can't be changed here.
router.put('/me', verifyToken, async (req, res) => {
    const { values, error } = validateProfileUpdate(req.body || {});
    if (error) {
        return res.status(400).json({ error });
    }

    try {
        const [result] = await pool.query(
            `UPDATE users SET name = ?, surename = ?, nickname = ?, email = ?, bio = ?
             WHERE firebase_uid = ?`,
            [values.name, values.surename, values.nickname, values.email, values.bio || null, req.firebaseUser.uid]
        );
        if (result.affectedRows === 0) {
            return res.status(404).json({ error: 'User not provisioned yet' });
        }
    } catch (err) {
        if (err.code === 'ER_DUP_ENTRY') {
            const field = err.sqlMessage && err.sqlMessage.includes('email') ? 'email' : 'nickname';
            return res.status(409).json({ error: `That ${field} is already taken`, field });
        }
        throw err;
    }

    const [rows] = await pool.query(`${SELECT_PROFILE} WHERE firebase_uid = ?`, [req.firebaseUser.uid]);
    res.json(rows[0]);
});

const MAX_PICTURE_URL_LENGTH = 500;

// Returns the trimmed http(s) URL, '' to remove the picture, or null when the value isn't a valid link.
function parsePictureUrl(value) {
    const url = typeof value === 'string' ? value.trim() : '';
    if (!url) return '';
    if (url.length > MAX_PICTURE_URL_LENGTH) return null;
    try {
        const { protocol } = new URL(url);
        return protocol === 'http:' || protocol === 'https:' ? url : null;
    } catch {
        return null;
    }
}

// Email/password users only: Google accounts keep the photo from their Google profile.
function requirePasswordAccount(req, res, next) {
    if (req.firebaseUser.signInProvider !== 'password') {
        return res.status(403).json({ error: 'Only accounts that sign in with email and password can change their picture' });
    }
    next();
}

// Sets the profile picture to a link of an image hosted online (an empty url removes it).
router.put('/me/profile-picture', verifyToken, requirePasswordAccount, async (req, res) => {
    const url = parsePictureUrl((req.body || {}).url);
    if (url === null) {
        return res.status(400).json({ error: 'Enter a valid image link starting with http:// or https://' });
    }

    const [result] = await pool.query('UPDATE users SET profile_picture = ? WHERE firebase_uid = ?', [
        url || null,
        req.firebaseUser.uid,
    ]);
    if (result.affectedRows === 0) {
        return res.status(404).json({ error: 'User not provisioned yet' });
    }

    const [rows] = await pool.query(`${SELECT_PROFILE} WHERE firebase_uid = ?`, [req.firebaseUser.uid]);
    res.json(rows[0]);
});

module.exports = router;
