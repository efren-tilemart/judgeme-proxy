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

// Sanitize review data to only include public fields
const sanitizeReview = (review) => {
  return {
    rating: review.rating,
    created_at: review.created_at,
    product_handle: review.product_handle,
    product_title: review.product_title,
    title: review.title,
    body: review.body,
    reviewer: {
      name: review.reviewer?.name
    },
    pictures: review.pictures?.map(pic => ({
      urls: {
        huge: pic.urls?.huge,
        compact: pic.urls?.compact
      }
    })) || []
  };
};

// Simple in-memory cache
let reviewsCache = {
  data: null,
  lastFetched: null
};

const CACHE_DURATION = 24 * 60 * 60 * 1000; // 24 hours in milliseconds

const axiosInstance = axios.create({
  timeout: 5000, // 5 second timeout
  headers: {
    'Accept-Encoding': 'gzip,deflate',
    'Connection': 'keep-alive',
    'Cache-Control': 'no-cache',
    'Accept': 'application/json'
  }
});

// Proxy route for fetching reviews
app.get('/fetch', async (req, res) => {
  try {
    // Check if we have cached data that's still valid
    if (reviewsCache.data && reviewsCache.lastFetched && 
        (Date.now() - reviewsCache.lastFetched) < CACHE_DURATION) {
      return res.json(reviewsCache.data);
    }

    const perPage = 100;
    let currentPage = 1;
    let hasMoreReviews = true;
    const allReviews = [];

    while (hasMoreReviews) {
      const response = await axiosInstance.get('https://judge.me/api/v1/reviews', {
        params: {
          api_token: JUDGE_ME_API_TOKEN,
          shop_domain: 'mytilemart.myshopify.com',
          per_page: perPage,
          page: currentPage
        }
      });

      const currentReviews = response.data.reviews || [];
      
      if (currentReviews.length === 0 || currentReviews.length < perPage) {
        hasMoreReviews = false;
      }

      allReviews.push(...currentReviews);
      currentPage++;
    }

    // Sanitize all reviews
    const sanitizedReviews = {
      reviews: allReviews
        .filter(review => review.published === true && review.rating >= 4)
        .map(sanitizeReview)
    };

    // Update cache
    reviewsCache = {
      data: sanitizedReviews,
      lastFetched: Date.now()
    };

    // Cache the response for 24 hours
    res.set('Cache-Control', 'public, max-age=86400');
    res.json(sanitizedReviews);
  } catch (error) {
    if (reviewsCache.data) {
      return res.json(reviewsCache.data);
    }
    res.status(500).json({ error: 'Failed to fetch reviews' });
  }
});

app.listen(PORT, () => {
  console.log(`App running on port ${PORT}`);
});
