require('dotenv').config();

// 1. Bring in the express library and create an "app" — this is your server.
const express = require('express');
const cors = require('cors');
const usersRouter = require('./routes/users');
const awardCategoriesRouter = require('./routes/awardCategories');
const gamesRouter = require('./routes/games');
const votesRouter = require('./routes/votes');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3001;

// 2. Define routes: a route = an HTTP method (GET, POST, ...) + a path.
//    Each route gets a handler function: (req, res) => { ... }
//    - req = the incoming request (params, query string, body, headers)
//    - res = used to send something back to whoever called this route

// A plain-text route, viewable directly by opening the URL in a browser.
app.get('/', (req, res) => {
    res.send('Hello World');
});

// A JSON route — this is the shape real APIs use, since the frontend
// (Angular, in this case) expects to parse a JSON response, not raw text.
app.get('/api/hello', (req, res) => {
    res.json({ message: 'Hello World' });
});

app.use('/api/users', usersRouter);
app.use('/api/award-categories', awardCategoriesRouter);
app.use('/api/games', gamesRouter);
app.use('/api/votes', votesRouter);

// 3. Start listening for incoming connections on PORT, but only when run directly
//    (`npm start`). On Vercel there is no long-running server: Vercel imports the
//    exported app below and calls it for each request.
if (require.main === module) {
    app.listen(PORT, () => {
        console.log(`Server listening on http://localhost:${PORT}`);
    });
}

module.exports = app;
