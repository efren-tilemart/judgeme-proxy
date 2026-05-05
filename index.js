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

const INSTAGRAM_STORES = {
  tilemart: process.env.TILEMART_INSTAGRAM_ACCESS_TOKEN || process.env.INSTAGRAM_ACCESS_TOKEN,
  elittile: process.env.ELITTILE_INSTAGRAM_ACCESS_TOKEN
};

function normalizeInstagramStore(rawStore) {
  return String(rawStore)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, '');
}

function getInstagramStore(storeKey) {
  const normalizedStoreKey = normalizeInstagramStore(storeKey);
  const accessToken = INSTAGRAM_STORES[normalizedStoreKey];

  if (!Object.prototype.hasOwnProperty.call(INSTAGRAM_STORES, normalizedStoreKey)) {
    const error = new Error(`Unknown Instagram store: ${normalizedStoreKey}`);
    error.statusCode = 400;
    error.details = {
      requestedStore: normalizedStoreKey,
      availableStores: Object.keys(INSTAGRAM_STORES)
    };
    throw error;
  }

  if (!accessToken) {
    const error = new Error(`Instagram credentials are not configured for store: ${normalizedStoreKey}`);
    error.statusCode = 500;
    error.details = {
      requestedStore: normalizedStoreKey,
      missingEnv: `${normalizedStoreKey.toUpperCase()}_INSTAGRAM_ACCESS_TOKEN`
    };
    throw error;
  }

  return { storeKey: normalizedStoreKey, accessToken };
}

// Initialize Shopify GraphQL client
const client = createGraphQLClient({
  url: `https://${SHOP_URL}/admin/api/2024-01/graphql.json`,
  headers: {
    'Content-Type': 'application/json',
    'X-Shopify-Access-Token': SHOPIFY_ACCESS_TOKEN,
  },
  fetchApi: fetch,
  onRequestError: ({ error }) => {
    console.error('GraphQL request error:', {
      message: error.message,
      status: error.networkStatusCode,
      response: error.response
    });
  }
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

// Update the GraphQL query to first find the product by handle
const PRICE_QUERY = `
  query GetProductPrice($handle: String!) {
    products(first: 1, query: $handle) {
      nodes {
        id
        handle
        title
        productType
        variants(first: 1) {
          nodes {
            id
            price
            compareAtPrice
            inventoryQuantity
            inventoryManagement
            inventoryPolicy
            metafields(first: 10, namespace: "pricelist") {
              nodes {
                key
                value
              }
            }
          }
        }
        metafields(first: 10, namespace: "pricelist") {
          nodes {
            key
            value
          }
        }
      }
    }
  }
`;

// Update the price endpoint to handle the new query structure
app.get('/price/:handle', async (req, res) => {
  try {
    const { handle } = req.params;
    console.log('Fetching price for handle:', handle);

    const response = await client.request(PRICE_QUERY, {
      variables: {
        handle: `handle:${handle}`
      }
    });

    console.log('GraphQL Response:', JSON.stringify(response, null, 2));

    if (!response.data?.products?.nodes?.[0]) {
      return res.status(404).json({ 
        error: 'Product not found',
        handle: handle
      });
    }

    const product = response.data.products.nodes[0];
    const variant = product.variants.nodes[0];

    const variantMetafields = variant.metafields.nodes.reduce((acc, meta) => {
      acc[meta.key] = meta.value;
      return acc;
    }, {});
    const productMetafields = product.metafields.nodes.reduce((acc, meta) => {
      acc[meta.key] = meta.value;
      return acc;
    }, {});

    // Process pricing information
    const priceInfo = {
      currentPrice: variant.price,
      compareAtPrice: variant.compareAtPrice,
      onSale: variant.compareAtPrice > variant.price,
      inventory: {
        quantity: variant.inventoryQuantity,
        management: variant.inventoryManagement,
        policy: variant.inventoryPolicy
      },
      uom: (variantMetafields.uom || '').toUpperCase(),
      sellUnit: (variantMetafields.sell_unit || '').toUpperCase(),
      status: (productMetafields.status || '').toUpperCase(),
      productType: (product.productType || '').toUpperCase()
    };

    // Calculate conversion values
    priceInfo.conversion = calculateConversion(priceInfo.uom, priceInfo.sellUnit, variantMetafields);
    
    // Calculate price per square foot
    if (product.productType.toUpperCase() !== 'TRIM') {
      priceInfo.pricePerSqFt = calculatePricePerSqFt(priceInfo, variantMetafields);
    }

    // Determine stock status
    priceInfo.stock = determineStockStatus(priceInfo);

    // Additional logic from Liquid template
    const stockNotice = determineStockNotice(priceInfo);
    const unitDisplay = determineUnitDisplay(priceInfo.sellUnit);

    res.json({
      ...priceInfo,
      stockNotice,
      unitDisplay
    });
  } catch (error) {
    console.error('Error fetching price:', error);
    res.status(500).json({
      error: 'Failed to fetch price information',
      details: error.message
    });
  }
});

function calculateConversion(uom, sellUnit, metafields) {
  if (!uom || !sellUnit) return 1;

  switch(uom) {
    case 'SF':
      switch(sellUnit) {
        case 'SF': return 1;
        case 'EA':
        case 'SHT': return Number(metafields.sf_ea);
        case 'BX':
        case 'SET': return Number(metafields.sf_box);
        case 'PLT': return Number(metafields.sf_plt);
        default: return 1;
      }
    // Add other conversion cases as needed
    default:
      return 1;
  }
}

function calculatePricePerSqFt(priceInfo, metafields) {
  const { uom, sellUnit, currentPrice, compareAtPrice } = priceInfo;
  let totalSf = 1;

  if (uom === 'SF') {
    switch(sellUnit) {
      case 'SF':
        totalSf = 1;
        break;
      case 'EA':
      case 'SHT':
        totalSf = Number(metafields.sf_ea);
        break;
      case 'BX':
      case 'SET':
        totalSf = Number(metafields.sf_box);
        break;
      case 'PLT':
        totalSf = Number(metafields.sf_box) * Number(metafields.bx_plt);
        break;
    }
  }

  return {
    current: totalSf ? (currentPrice / totalSf) : currentPrice,
    compare: compareAtPrice ? (compareAtPrice / totalSf) : null
  };
}

function determineStockStatus(priceInfo) {
  const { status, inventory } = priceInfo;
  const result = {
    notice: '',
    subtext: '',
    color: '',
    hasBoldText: false
  };

  if (status === 'ACTIVE') {
    if (inventory.management === 'shopify' && inventory.policy === 'continue') {
      if (inventory.quantity === 0) {
        result.notice = 'Temporarily';
        result.subtext = 'Oversold';
        result.color = '#FD8B07';
        result.hasBoldText = true;
      }
    }
  }

  return result;
}

function determineStockNotice(priceInfo) {
  const { status, inventory } = priceInfo;
  let notice = '';
  let subtext = '';
  let color = '';
  let hasBoldText = false;

  if (status === 'ACTIVE') {
    if (inventory.management === 'shopify' && inventory.policy === 'continue') {
      if (inventory.quantity === 0) {
        notice = 'Temporarily';
        subtext = 'Oversold';
        color = '#FD8B07';
        hasBoldText = true;
      } else if (inventory.quantity > 0) {
        notice = 'Low Stock';
        subtext = `Only ${inventory.quantity} left!`;
        color = '#FD8B07';
      }
    }
  } else if (status === 'DISCONTINUED') {
    if (inventory.management === 'shopify' && inventory.policy === 'deny') {
      if (inventory.quantity === 0) {
        notice = 'Discontinued';
        subtext = 'Out of Stock';
        color = '#DC3545';
      } else if (inventory.quantity > 0) {
        notice = 'Discontinued';
        subtext = `Only ${inventory.quantity} left!`;
        color = '#FD8B07';
      }
    }
  } else if (status === 'CLEARANCE') {
    if (inventory.management === 'shopify' && inventory.policy === 'deny') {
      if (inventory.quantity > 0) {
        subtext = `Only ${inventory.quantity} left!`;
        color = '#FD8B07';
      } else {
        subtext = 'Out of Stock';
        color = '#DC3545';
      }
    }
  }

  return { notice, subtext, color, hasBoldText };
}

function determineUnitDisplay(sellUnit) {
  switch (sellUnit) {
    case 'BX':
      return { singular: 'box', plural: 'boxes' };
    case 'SF':
      return { singular: 'sq.ft', plural: 'sq.ft' };
    case 'EA':
      return { singular: 'piece', plural: 'pieces' };
    case 'SHT':
      return { singular: 'sheet', plural: 'sheets' };
    case 'SET':
      return { singular: 'set', plural: 'sets' };
    case 'PLT':
      return { singular: 'pallet', plural: 'pallets' };
    default:
      return { singular: '', plural: '' };
  }
}

// Order query
const ORDER_QUERY = `
  query GetOrder($id: ID!) {
    order(id: $id) {
      id
      name
      email
      phone
      totalPriceSet {
        shopMoney {
          amount
          currencyCode
        }
      }
      subtotalPriceSet {
        shopMoney {
          amount
          currencyCode
        }
      }
      totalShippingPriceSet {
        shopMoney {
          amount
          currencyCode
        }
      }
      totalTaxSet {
        shopMoney {
          amount
          currencyCode
        }
      }
      lineItems(first: 50) {
        nodes {
          title
          quantity
          originalUnitPriceSet {
            shopMoney {
              amount
              currencyCode
            }
          }
          variant {
            id
            sku
            product {
              handle
            }
          }
        }
      }
      shippingAddress {
        address1
        address2
        city
        province
        zip
        country
      }
      fulfillments {
        trackingCompany
        trackingNumbers
      }
    }
  }
`;

// Orders endpoint
app.get('/orders/:id', async (req, res) => {
  try {
    const { id } = req.params;
    
    // Use REST API endpoint
    const response = await fetch(`https://${SHOP_URL}/admin/api/2024-01/orders/${id}.json`, {
      headers: {
        'X-Shopify-Access-Token': SHOPIFY_ACCESS_TOKEN,
        'Content-Type': 'application/json'
      }
    });

    if (!response.ok) {
      console.error('Shopify API error:', await response.text());
      return res.status(response.status).json({
        error: 'Failed to fetch order',
        orderId: id,
        status: response.status
      });
    }

    const data = await response.json();
    res.json(data);
    
  } catch (error) {
    console.error('Error fetching order:', error);
    res.status(500).json({
      error: 'Failed to fetch order information',
      details: error.message,
      requestedId: id
    });
  }
});

const instagramCache = new Map();

function getCachedValue(cache, storeKey) {
  return cache.get(storeKey) || { data: null, lastFetched: null };
}

function setCachedValue(cache, storeKey, data) {
  cache.set(storeKey, {
    data,
    lastFetched: Date.now()
  });
}

async function handleInstagramRequest(req, res, storeKey = 'tilemart') {
  try {
    const store = getInstagramStore(storeKey);
    const cachedFeed = getCachedValue(instagramCache, store.storeKey);

    if (cachedFeed.data && cachedFeed.lastFetched &&
        (Date.now() - cachedFeed.lastFetched) < CACHE_DURATION) {
      return res.json(cachedFeed.data);
    }

    const INSTAGRAM_API_URL = 'https://graph.instagram.com/me/media';
    
    const response = await fetch(`${INSTAGRAM_API_URL}?fields=id,caption,media_type,media_url,permalink&access_token=${store.accessToken}`);

    if (!response.ok) {
      if (cachedFeed.data) {
        return res.json(cachedFeed.data);
      }
      
      console.error('Instagram API error:', await response.text());
      return res.status(response.status).json({
        error: 'Failed to fetch Instagram feed',
        status: response.status,
        store: store.storeKey
      });
    }

    const data = await response.json();
    
    // Transform the data to include only what we need
    const transformedData = {
      posts: data.data.map(post => ({
        id: post.id,
        caption: post.caption,
        mediaType: post.media_type,
        mediaUrl: post.media_url,
        permalink: post.permalink
      })),
      paging: data.paging
    };

    setCachedValue(instagramCache, store.storeKey, transformedData);

    // Cache the response for 24 hours
    res.set('Cache-Control', 'public, max-age=86400');
    res.json(transformedData);

  } catch (error) {
    const normalizedStoreKey = normalizeInstagramStore(storeKey);
    const cachedFeed = getCachedValue(instagramCache, normalizedStoreKey);

    if (cachedFeed.data) {
      return res.json(cachedFeed.data);
    }

    console.error('Error fetching Instagram feed:', error);
    return res.status(error.statusCode || 500).json({
      error: error.message || 'Failed to fetch Instagram feed',
      ...(error.details ? { details: error.details } : {})
    });
  }
}

// Instagram feed endpoints
app.get('/instagram', (req, res) => handleInstagramRequest(req, res, 'tilemart'));
app.get('/instagram/elittile', (req, res) => handleInstagramRequest(req, res, 'elittile'));

// Enhanced version with better error handling and logging
app.get('/collection/:handle', async (req, res) => {
  try {
    const { handle } = req.params;
    const first = parseInt(req.query.limit) || 250;
    const after = req.query.after || null;

    console.log('Fetching collection with handle:', handle);
    console.log('Query parameters:', { first, after });

    // Modified query to include error checking
    const PAGINATED_COLLECTION_QUERY = `
      query GetProductsWithMetafields($collectionHandle: String!, $first: Int!, $after: String) {
        collectionByHandle(handle: $collectionHandle) {
          id
          title
          handle
          products(first: $first, after: $after) {
            pageInfo {
              hasNextPage
              endCursor
            }
            nodes {
              id
              title
              handle
              metafield(namespace: "primary", key: "application") {
                value
              }
            }
          }
        }
      }
    `;

    console.log('Executing GraphQL query...');
    const response = await client.request(PAGINATED_COLLECTION_QUERY, {
      variables: {
        collectionHandle: handle,
        first: first,
        after: after
      }
    });

    console.log('GraphQL Response:', JSON.stringify(response, null, 2));

    if (!response.data?.collectionByHandle) {
      console.log('Collection not found in response:', response);
      return res.status(404).json({
        error: 'Collection not found',
        handle: handle,
        debug: {
          responseData: response.data,
          shopUrl: SHOP_URL,
          timestamp: new Date().toISOString()
        }
      });
    }

    const collection = response.data.collectionByHandle;
    const transformedData = {
      id: collection.id,
      title: collection.title,
      handle: collection.handle,
      products: collection.products.nodes.map(product => ({
        id: product.id,
        title: product.title,
        handle: product.handle,
        application: product.metafield?.value || null
      })),
      pageInfo: collection.products.pageInfo
    };

    res.set('Cache-Control', 'public, max-age=300');
    console.log('Successfully transformed collection data:', transformedData);
    res.json(transformedData);

  } catch (error) {
    console.error('Detailed error fetching collection products:', {
      error: error.message,
      stack: error.stack,
      handle: req.params.handle,
      response: error.response?.data,
      extensions: error.extensions
    });

    res.status(500).json({
      error: 'Failed to fetch collection products',
      details: error.message || 'Unknown error',
      handle: req.params.handle,
      debug: {
        errorType: error.constructor.name,
        timestamp: new Date().toISOString(),
        shopUrl: SHOP_URL
      }
    });
  }
});

// Modify the collections endpoint with a simpler query and better error handling
app.get('/collections', async (req, res) => {
  try {
    // Updated query with better error handling
    const COLLECTIONS_QUERY = `
      query GetCollections {
        collections(first: 50) {
          edges {
            node {
              id
              handle
              title
              productsCount
              updatedAt
            }
          }
          pageInfo {
            hasNextPage
            endCursor
          }
        }
        shop {
          name
          id
        }
      }
    `;

    console.log('Attempting to fetch collections...');
    console.log('Shop URL:', SHOP_URL);
    console.log('Access Token length:', SHOPIFY_ACCESS_TOKEN?.length);
    console.log('GraphQL Endpoint:', `https://${SHOP_URL}/admin/api/2024-01/graphql.json`);

    const response = await client.request(COLLECTIONS_QUERY);
    
    console.log('Raw GraphQL Response:', JSON.stringify(response, null, 2));

    if (!response.data?.collections?.edges) {
      return res.status(404).json({
        error: 'No collections found',
        debug: {
          responseData: response.data,
          shopUrl: SHOP_URL,
          timestamp: new Date().toISOString(),
          hasToken: !!SHOPIFY_ACCESS_TOKEN,
          shopInfo: response.data?.shop
        }
      });
    }

    const collections = response.data.collections.edges.map(edge => ({
      id: edge.node.id,
      handle: edge.node.handle,
      title: edge.node.title,
      productsCount: edge.node.productsCount,
      updatedAt: edge.node.updatedAt
    }));

    res.json({
      collections,
      count: collections.length,
      shop: response.data.shop,
      timestamp: new Date().toISOString(),
      debug: {
        shopUrl: SHOP_URL,
        apiVersion: '2024-01'
      }
    });

  } catch (error) {
    console.error('Detailed collections error:', {
      message: error.message,
      response: error.response?.errors,
      extensions: error.extensions,
      networkStatus: error.networkStatusCode
    });

    res.status(error.networkStatusCode || 500).json({
      error: 'Failed to fetch collections',
      details: error.message,
      debug: {
        errorType: error.constructor.name,
        shopUrl: SHOP_URL,
        timestamp: new Date().toISOString(),
        hasToken: !!SHOPIFY_ACCESS_TOKEN,
        tokenLength: SHOPIFY_ACCESS_TOKEN?.length,
        graphQLErrors: error.response?.errors || [],
        networkStatusCode: error.networkStatusCode
      }
    });
  }
});

app.listen(PORT, () => {
  console.log(`App running on port ${PORT}`);
});
