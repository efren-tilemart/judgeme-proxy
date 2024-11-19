import 'dotenv/config';
import express from 'express';
import axios from 'axios';
import { createGraphQLClient } from '@shopify/graphql-client';
import cors from 'cors';

const app = express();
const PORT = process.env.PORT || 3000;

// Environment variables
const JUDGE_ME_API_TOKEN = process.env.JUDGE_ME_API_TOKEN;
const SHOPIFY_ACCESS_TOKEN = process.env.SHOPIFY_ACCESS_TOKEN;
const SHOP_URL = 'mytilemart.myshopify.com';

// Initialize Shopify GraphQL client
const client = createGraphQLClient({
  url: `https://${SHOP_URL}/admin/api/2024-01/graphql.json`,
  headers: {
    'Content-Type': 'application/json',
    'X-Shopify-Access-Token': SHOPIFY_ACCESS_TOKEN,
  },
  fetchApi: fetch,
});

// Allow CORS from specific origin
const allowedOrigins = [
  'https://tilemart.com',
  'http://127.0.0.1:9292', 
  'http://localhost:9292',
  'https://judgeme-proxy.vercel.app',
  'http://localhost:3000',
  'http://localhost:3001'
];

// CORS configuration
const corsOptions = {
  origin: '*', // Be more specific in production
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true,
  maxAge: 86400,
};

// Apply CORS middleware
app.use(cors(corsOptions));

// Ensure middleware order
app.use(express.json());

// Add request logging
app.use((req, res, next) => {
  console.log('Request Headers:', req.headers);
  console.log('Request Method:', req.method);
  console.log('Request URL:', req.url);
  next();
});

// Add response logging
app.use((req, res, next) => {
  const originalSend = res.send;
  res.send = function() {
    console.log('Response Headers:', res.getHeaders());
    return originalSend.apply(res, arguments);
  };
  next();
});

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

// Middleware
app.use(express.json());
app.use(cors());

// Shopify products endpoint
app.post('/products', async (req, res) => {
  try {
    const { handles } = req.body;
    
    if (!handles || !Array.isArray(handles)) {
      return res.status(400).json({
        error: 'Invalid request. Please provide an array of product handles.'
      });
    }

    // Split handles into chunks of 50 to avoid query complexity limits
    const chunkSize = 50;
    const handleChunks = [];
    for (let i = 0; i < handles.length; i += chunkSize) {
      handleChunks.push(handles.slice(i, i + chunkSize));
    }

    const query = `
      query GetProductsByHandle($query: String!) {
        products(first: 50, query: $query) {  # Increased from 10 to 50
          nodes {
            id
            handle
            title
            featuredImage {
              url
            }
            onlineStoreUrl
            metafields(first: 1, namespace: "custom") {
              nodes {
                key
                value
                reference {
                  ... on Product {
                    title
                    onlineStoreUrl
                  }
                }
              }
            }
          }
        }
      }
    `;

    // Fetch products in parallel for each chunk
    const allProducts = [];
    await Promise.all(
      handleChunks.map(async (handleChunk) => {
        const queryString = handleChunk.map(handle => `handle:'${handle}'`).join(' OR ');
        console.log(`Fetching chunk with ${handleChunk.length} handles...`);

        const response = await client.request(query, {
          variables: {
            query: queryString
          }
        });

        if (response.data?.products?.nodes) {
          allProducts.push(...response.data.products.nodes);
        }
      })
    );

    // Process all products
    const products = allProducts.map(node => {
      const parentMetafield = node.metafields.nodes.find(m => m.key === 'parent_product');
      return {
        handle: node.handle,
        title: node.title,
        featuredImage: node.featuredImage?.url || null,
        url: node.onlineStoreUrl,
        parentProduct: parentMetafield?.reference ? {
          title: parentMetafield.reference.title,
          url: parentMetafield.reference.onlineStoreUrl
        } : null
      };
    });

    console.log(`Requested ${handles.length} products, found ${products.length} products`);

    res.json({ products });
  } catch (error) {
    console.error('Error in products route:', error);
    res.status(500).json({
      error: 'An error occurred while fetching products',
      details: error.message || 'Unknown error'
    });
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
