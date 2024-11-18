require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

// Environment variable for API token
const JUDGE_ME_API_TOKEN = process.env.JUDGE_ME_API_TOKEN;

// Allow CORS from specific origin
const allowedOrigins = ['https://tilemart.com', 'http://127.0.0.1:9292', 'http://localhost:9292'];

app.use(cors({
  origin: (origin, callback) => {
    if (allowedOrigins.includes(origin) || !origin) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
}));

// Proxy route for fetching reviews
app.get('/fetch', async (req, res) => {
  try {
    const perPage = req.query.per_page || 99; // Optional parameter
    const response = await axios.get('https://judge.me/api/v1/reviews', {
      params: {
        api_token: JUDGE_ME_API_TOKEN,
        shop_domain: 'mytilemart.myshopify.com',
        per_page: perPage,
      },
    });

    // Return the fetched data
    res.json(response.data);
  } catch (error) {
    console.error('Error fetching Judge.me reviews:', error.message);
    res.status(500).json({ error: 'Failed to fetch reviews' });
  }
});

app.listen(PORT, () => {
  console.log(`App running on port ${PORT}`);
});
