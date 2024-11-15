require('dotenv').config();
const express = require('express');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 3000;

// Environment variable for API token
const JUDGE_ME_API_TOKEN = process.env.JUDGE_ME_API_TOKEN;

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
