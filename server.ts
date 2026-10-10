import 'dotenv/config';
import express from 'express';
import { createServer as createViteServer } from 'vite';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;

const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

const REVIEWS_FILE = path.join(DATA_DIR, 'reviews.json');
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');
const CREDENTIALS_FILE = path.join(DATA_DIR, 'oauth_tokens.json');
const STATE_FILE = path.join(DATA_DIR, 'oauth_state.json');

// Ensure initial files exist
if (!fs.existsSync(REVIEWS_FILE)) {
  fs.writeFileSync(REVIEWS_FILE, JSON.stringify([], null, 2));
}
if (!fs.existsSync(SETTINGS_FILE)) {
  const defaultSettings = {
    businessName: "Kestrel Business Funding",
    businessDescription: "US small-business lender offering working capital loans, equipment finance, business lines of credit, merchant cash advances, and SBA loans.",
    supportedThemes: ["working capital", "equipment finance", "line of credit", "merchant cash advance", "sba loan", "business loan", "small business financing", "business funding"],
    unsupportedThemes: ["personal loan", "mortgage", "car loan", "auto loan", "student loan", "grant", "hiring", "jobs", "career", "salary"],
    minClicksThreshold: 5,
    minSpendThreshold: 50.00,
    minConversionsThreshold: 1,
    confidenceThreshold: 70,
    dataSourceMode: "csv"
  };
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(defaultSettings, null, 2));
}

async function getValidAccessToken(): Promise<string | null> {
  if (!fs.existsSync(CREDENTIALS_FILE)) return null;
  try {
    const tokenData = JSON.parse(fs.readFileSync(CREDENTIALS_FILE, 'utf8'));
    if (!tokenData || !tokenData.refresh_token) return null;

    // Check if access token is still valid (with 60s buffer)
    if (tokenData.access_token && tokenData.expires_at && Date.now() < tokenData.expires_at - 60000) {
      return tokenData.access_token;
    }

    // Refresh token
    const clientId = process.env.GOOGLE_ADS_CLIENT_ID;
    const clientSecret = process.env.GOOGLE_ADS_CLIENT_SECRET;
    if (!clientId || !clientSecret) return null;

    const refreshRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        refresh_token: tokenData.refresh_token,
        grant_type: 'refresh_token'
      })
    });

    const refreshData = await refreshRes.json();
    if (!refreshRes.ok || refreshData.error) {
      console.error('Token refresh failed:', refreshData);
      return null;
    }

    const updatedTokenData = {
      ...tokenData,
      access_token: refreshData.access_token,
      expires_at: Date.now() + (refreshData.expires_in || 3600) * 1000
    };
    fs.writeFileSync(CREDENTIALS_FILE, JSON.stringify(updatedTokenData, null, 2));
    return refreshData.access_token;
  } catch (err) {
    console.error('Token refresh exception:', err);
    return null;
  }
}

async function startServer() {
  const app = express();
  app.use(express.json({ limit: '10mb' }));

  // API Health
  app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
  });

  // Google Ads Status & Config
  app.get('/api/google-ads/status', (req, res) => {
    const clientId = process.env.GOOGLE_ADS_CLIENT_ID;
    const clientSecret = process.env.GOOGLE_ADS_CLIENT_SECRET;
    const developerToken = process.env.GOOGLE_ADS_DEVELOPER_TOKEN;

    const clientIdConfigured = !!clientId && clientId !== 'MY_GOOGLE_ADS_CLIENT_ID';
    const clientSecretConfigured = !!clientSecret && clientSecret !== 'MY_GOOGLE_ADS_CLIENT_SECRET';
    const developerTokenConfigured = !!developerToken && developerToken !== 'MY_GOOGLE_ADS_DEVELOPER_TOKEN';

    let connected = false;
    let selectedAccount = null;

    if (fs.existsSync(CREDENTIALS_FILE)) {
      try {
        const tokenData = JSON.parse(fs.readFileSync(CREDENTIALS_FILE, 'utf8'));
        if (tokenData && tokenData.refresh_token) {
          connected = true;
          selectedAccount = tokenData.selectedAccount || null;
        }
      } catch (e) {
        // invalid token file
      }
    }

    res.json({
      connected,
      clientIdConfigured,
      clientSecretConfigured,
      developerTokenConfigured,
      selectedAccount,
      error: !clientIdConfigured || !clientSecretConfigured || !developerTokenConfigured 
        ? 'Google Ads API credentials (Client ID, Client Secret, Developer Token) are not fully configured in backend environment variables.'
        : null
    });
  });

  // OAuth Auth URL generation with cryptographically secure single-use state
  app.get('/api/google-ads/auth', (req, res) => {
    const clientId = process.env.GOOGLE_ADS_CLIENT_ID;
    const clientSecret = process.env.GOOGLE_ADS_CLIENT_SECRET;
    const developerToken = process.env.GOOGLE_ADS_DEVELOPER_TOKEN;

    if (!clientId || clientId === 'MY_GOOGLE_ADS_CLIENT_ID' || !clientSecret || !developerToken || developerToken === 'MY_GOOGLE_ADS_DEVELOPER_TOKEN') {
      return res.status(400).json({ 
        error: 'Required Google Ads environment variables (GOOGLE_ADS_CLIENT_ID, GOOGLE_ADS_CLIENT_SECRET, GOOGLE_ADS_DEVELOPER_TOKEN) are missing or invalid.' 
      });
    }

    const redirectUri = process.env.GOOGLE_ADS_REDIRECT_URI || `${process.env.APP_URL || 'http://localhost:3000'}/auth/google/callback`;
    const scope = encodeURIComponent('https://www.googleapis.com/auth/adwords');
    
    // Cryptographically secure state with 10-minute expiration
    const state = crypto.randomBytes(32).toString('hex');
    const statePayload = {
      state,
      expires_at: Date.now() + 10 * 60 * 1000
    };
    fs.writeFileSync(STATE_FILE, JSON.stringify(statePayload));

    const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?client_id=${clientId}&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=code&scope=${scope}&access_type=offline&prompt=consent&state=${state}`;
    res.json({ authUrl });
  });

  // OAuth Callback with strict state validation and real token exchange
  app.get('/auth/google/callback', async (req, res) => {
    const { code, state, error } = req.query;
    if (error) {
      return res.redirect(`/?oauth_error=${encodeURIComponent(String(error))}`);
    }

    // Validate cryptographically secure state
    if (!fs.existsSync(STATE_FILE)) {
      return res.redirect(`/?oauth_error=${encodeURIComponent('OAuth state session not found.')}`);
    }

    try {
      const stateData = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
      fs.unlinkSync(STATE_FILE); // single-use

      if (!state || state !== stateData.state || Date.now() > stateData.expires_at) {
        return res.redirect(`/?oauth_error=${encodeURIComponent('Invalid, mismatched, or expired OAuth state parameter (CSRF protection).')}`);
      }
    } catch (e) {
      return res.redirect(`/?oauth_error=${encodeURIComponent('OAuth state validation error.')}`);
    }

    if (!code) {
      return res.redirect(`/?oauth_error=${encodeURIComponent('Authorization code missing from Google callback.')}`);
    }

    const clientId = process.env.GOOGLE_ADS_CLIENT_ID;
    const clientSecret = process.env.GOOGLE_ADS_CLIENT_SECRET;
    const redirectUri = process.env.GOOGLE_ADS_REDIRECT_URI || `${process.env.APP_URL || 'http://localhost:3000'}/auth/google/callback`;

    try {
      const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          code: String(code),
          client_id: clientId || '',
          client_secret: clientSecret || '',
          redirect_uri: redirectUri,
          grant_type: 'authorization_code'
        })
      });

      const tokenData = await tokenRes.json();
      if (!tokenRes.ok || tokenData.error) {
        return res.redirect(`/?oauth_error=${encodeURIComponent(tokenData.error_description || tokenData.error || 'Token exchange failed')}`);
      }

      fs.writeFileSync(CREDENTIALS_FILE, JSON.stringify({
        refresh_token: tokenData.refresh_token,
        access_token: tokenData.access_token,
        expires_at: Date.now() + (tokenData.expires_in || 3600) * 1000,
        connected_at: new Date().toISOString()
      }, null, 2));

      res.redirect('/?google_ads_connected=true');
    } catch (err: any) {
      res.redirect(`/?oauth_error=${encodeURIComponent(`Token exchange exception: ${err.message}`)}`);
    }
  });

  // Disconnect Google Ads
  app.post('/api/google-ads/disconnect', (req, res) => {
    if (fs.existsSync(CREDENTIALS_FILE)) {
      fs.unlinkSync(CREDENTIALS_FILE);
    }
    res.json({ success: true, connected: false });
  });

  // Google Ads Accessible Customers Discovery (Real API Call)
  app.get('/api/google-ads/accounts', async (req, res) => {
    const accessToken = await getValidAccessToken();
    if (!accessToken) {
      return res.status(401).json({ error: 'Google Ads API not connected or refresh token expired. Please authenticate via OAuth.' });
    }

    const developerToken = process.env.GOOGLE_ADS_DEVELOPER_TOKEN;
    if (!developerToken || developerToken === 'MY_GOOGLE_ADS_DEVELOPER_TOKEN') {
      return res.status(400).json({ error: 'Google Ads Developer Token is not configured.' });
    }

    try {
      const apiRes = await fetch('https://googleads.googleapis.com/v18/customers:listAccessibleCustomers', {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'developer-token': developerToken,
          'Content-Type': 'application/json'
        }
      });

      const apiData = await apiRes.json();
      if (!apiRes.ok || apiData.error) {
        return res.status(400).json({ 
          error: apiData.error?.message || 'Failed to list accessible Google Ads customers. Verify developer token access level and API permissions.' 
        });
      }

      const resourceNames = apiData.resourceNames || []; // e.g. ["customers/1234567890"]
      const accounts = resourceNames.map((rn: string) => {
        const id = rn.replace('customers/', '');
        return { id, name: `Google Ads Account (${id})`, currency: 'USD', timezone: 'America/New_York' };
      });

      res.json({ accounts });
    } catch (err: any) {
      res.status(500).json({ error: `Google Ads API request exception: ${err.message}` });
    }
  });

  // Demo Mode endpoint
  app.get('/api/demo/search-terms', (req, res) => {
    const sampleTerms = generateKestrelSearchTerms();
    res.json({
      success: true,
      mode: 'sample',
      total: sampleTerms.length,
      searchTerms: sampleTerms
    });
  });

  // Fetch search terms from Google Ads GAQL (Real API Call)
  app.get('/api/google-ads/search-terms', async (req, res) => {
    const customerId = String(req.query.customerId || '').replace(/-/g, '');
    if (!customerId) {
      return res.status(400).json({ error: 'Customer ID is required to fetch live search terms report.' });
    }

    const accessToken = await getValidAccessToken();
    if (!accessToken) {
      return res.status(401).json({ error: 'Google Ads API not connected or session expired.' });
    }

    const developerToken = process.env.GOOGLE_ADS_DEVELOPER_TOKEN;
    if (!developerToken || developerToken === 'MY_GOOGLE_ADS_DEVELOPER_TOKEN') {
      return res.status(400).json({ error: 'Google Ads Developer Token is not configured.' });
    }

    try {
      const gaqlQuery = `SELECT search_term_view.search_term, campaign.name, ad_group.name, metrics.impressions, metrics.clicks, metrics.cost_micros, metrics.conversions, metrics.conversion_value FROM search_term_view`;
      
      const apiRes = await fetch(`https://googleads.googleapis.com/v18/customers/${customerId}/googleAds:searchStream`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'developer-token': developerToken,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ query: gaqlQuery })
      });

      const apiData = await apiRes.json();
      if (!apiRes.ok || apiData.error) {
        return res.status(400).json({ 
          error: apiData.error?.message || 'GAQL search term report request failed. Ensure target customer account has search traffic and standard API access.' 
        });
      }

      // Parse searchStream response format
      const searchTerms: any[] = [];
      if (Array.isArray(apiData)) {
        apiData.forEach((batch: any) => {
          if (batch.results) {
            batch.results.forEach((row: any, idx: number) => {
              const st = row.searchTermView || {};
              const camp = row.campaign || {};
              const ag = row.adGroup || {};
              const m = row.metrics || {};

              const cost = Number(m.costMicros || 0) / 1_000_000;
              const clicks = Number(m.clicks || 0);
              const conversions = Number(m.conversions || 0);
              const conversionValue = Number(m.conversionValue || 0);
              const impressions = Number(m.impressions || 0);

              searchTerms.push({
                row_id: `GAQL-${idx + 1}`,
                search_term: st.searchTerm || '',
                match_type: 'Exact', // default or mapped from search term match type if available
                campaign: camp.name || 'Live Campaign',
                ad_group: ag.name || 'Live Ad Group',
                impressions,
                clicks,
                cost,
                conversions,
                conversion_value: conversionValue
              });
            });
          }
        });
      }

      const settings = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
      const analyzed = searchTerms.map(t => analyzeSearchTerm(t, settings));

      res.json({
        customerId,
        total: analyzed.length,
        searchTerms: analyzed
      });
    } catch (err: any) {
      res.status(500).json({ error: `Google Ads GAQL query exception: ${err.message}` });
    }
  });

  // Triage analyze endpoint
  app.post('/api/triage/analyze', (req, res) => {
    const { searchTerms } = req.body;
    if (!searchTerms || !Array.isArray(searchTerms)) {
      return res.status(400).json({ error: 'Invalid search terms array' });
    }
    
    const settings = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
    const analyzed = searchTerms.map((term: any) => analyzeSearchTerm(term, settings));
    res.json({ success: true, analyzedCount: analyzed.length, results: analyzed });
  });

  // Reviews endpoints
  app.get('/api/reviews', (req, res) => {
    const reviews = JSON.parse(fs.readFileSync(REVIEWS_FILE, 'utf8'));
    res.json(reviews);
  });

  app.post('/api/reviews', (req, res) => {
    const reviewItem = req.body;
    const reviews = JSON.parse(fs.readFileSync(REVIEWS_FILE, 'utf8'));
    
    const existingIndex = reviews.findIndex((r: any) => r.row_id === reviewItem.row_id || r.search_term === reviewItem.search_term);
    const updatedItem = {
      ...reviewItem,
      updated_at: new Date().toISOString()
    };

    if (existingIndex >= 0) {
      reviews[existingIndex] = { ...reviews[existingIndex], ...updatedItem };
    } else {
      reviews.push({
        ...updatedItem,
        created_at: new Date().toISOString()
      });
    }

    fs.writeFileSync(REVIEWS_FILE, JSON.stringify(reviews, null, 2));
    res.json({ success: true, review: updatedItem });
  });

  // Settings endpoints
  app.get('/api/settings', (req, res) => {
    const settings = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
    res.json(settings);
  });

  app.post('/api/settings', (req, res) => {
    const newSettings = req.body;
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(newSettings, null, 2));
    res.json({ success: true, settings: newSettings });
  });

  // Benchmarks endpoint
  app.get('/api/benchmarks', (req, res) => {
    const reviews = JSON.parse(fs.readFileSync(REVIEWS_FILE, 'utf8'));
    res.json({
      totalReviewedCases: reviews.length,
      note: "Benchmarks are calculated dynamically from actual human reviewer overrides and decisions stored in the audit trail."
    });
  });

  // Vite middleware for frontend development
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true, hmr: false },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    app.use(express.static(path.join(__dirname, 'dist')));
    app.get('*', (req, res) => {
      res.sendFile(path.join(__dirname, 'dist', 'index.html'));
    });
  }

  app.listen(Number(PORT), '0.0.0.0', () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

function analyzeSearchTerm(term: any, settings: any) {
  const termLower = (term.search_term || '').toLowerCase();
  const cost = Number(term.cost) || 0;
  const clicks = Number(term.clicks) || 0;
  const conversions = Number(term.conversions) || 0;
  const conversionValue = Number(term.conversion_value) || 0;

  const isUnsupported = settings.unsupportedThemes.some((theme: string) => termLower.includes(theme));
  const isRelevant = settings.supportedThemes.some((theme: string) => termLower.includes(theme));

  let recommendation = "REVIEW";
  let intentCategory = "Ambiguous intent";
  let explanation = "";
  let confidence = 75;
  let triggeredRules: string[] = [];

  if (isUnsupported) {
    recommendation = "BLOCK";
    intentCategory = termLower.includes("grant") ? "Unsupported product intent" : termLower.includes("job") || termLower.includes("career") ? "Employment intent" : "Irrelevant intent";
    explanation = `Term contains unsupported/excluded theme conflicting with Kestrel business offerings.`;
    confidence = 96;
    triggeredRules.push("Rule: Unsupported Product / Intent Exclusion");
  } else if (isRelevant) {
    if (conversions >= (settings.minConversionsThreshold || 1) && cost > 0) {
      const roas = conversionValue / cost;
      if (roas >= 2.0 || conversions >= 3) {
        recommendation = "PROMOTE";
        intentCategory = "High commercial intent";
        explanation = `Strong performance with ${conversions} conversions and ROAS of ${roas.toFixed(2)}x on core business funding intent.`;
        confidence = 88;
        triggeredRules.push("Rule: High Commercial Intent & Positive ROAS");
      } else {
        recommendation = "REVIEW";
        intentCategory = "Research intent";
        explanation = `Relevant intent with moderate conversions, but ROAS (${roas.toFixed(2)}x) warrants closer bid optimization.`;
        confidence = 72;
        triggeredRules.push("Rule: Moderate Evidence - Requires ROAS Tuning");
      }
    } else if (clicks >= 15 && conversions === 0) {
      recommendation = "BLOCK";
      intentCategory = "Irrelevant intent";
      explanation = `High spend ($${cost.toFixed(2)}) and ${clicks} clicks with zero conversions indicating wasteful traffic.`;
      confidence = 85;
      triggeredRules.push("Rule: High Waste Spend / Zero Conversion Exclusions");
    } else {
      recommendation = "REVIEW";
      intentCategory = "Research intent";
      explanation = `Relevant search intent with insufficient conversion evidence (${clicks} clicks, ${conversions} conversions).`;
      confidence = 68;
      triggeredRules.push("Rule: Low Volume / Insufficient Sample Size");
    }
  } else {
    if (clicks > 30 && conversions === 0) {
      recommendation = "BLOCK";
      intentCategory = "Irrelevant intent";
      explanation = `Generic query with high traffic and zero conversions generating advertising waste.`;
      confidence = 80;
      triggeredRules.push("Rule: Generic Waste Exclusion");
    } else {
      recommendation = "REVIEW";
      intentCategory = "Ambiguous intent";
      explanation = `Unclassified term requiring manual review to determine business alignment.`;
      confidence = 60;
      triggeredRules.push("Rule: Unmatched Intent Fallback");
    }
  }

  const cvr = clicks > 0 ? (conversions / clicks) * 100 : 0;
  const cpa = conversions > 0 ? cost / conversions : cost;
  const roas = cost > 0 ? conversionValue / cost : 0;

  return {
    ...term,
    recommendation,
    intent_category: intentCategory,
    explanation,
    confidence,
    triggered_rules: triggeredRules,
    cvr: Number(cvr.toFixed(2)),
    cpa: Number(cpa.toFixed(2)),
    roas: Number(roas.toFixed(2))
  };
}

function generateKestrelSearchTerms() {
  const terms = [
    { row_id: "DEMO-1001", search_term: "working capital business loans", match_type: "Phrase", campaign: "Working Capital - Core US", ad_group: "Working Capital Loans", impressions: 14200, clicks: 890, cost: 3420.50, conversions: 54, conversion_value: 27000.00 },
    { row_id: "DEMO-1002", search_term: "equipment financing for small business", match_type: "Exact", campaign: "Equipment Finance - National", ad_group: "Heavy Machinery & Equipment", impressions: 9800, clicks: 640, cost: 2850.00, conversions: 42, conversion_value: 42000.00 },
    { row_id: "DEMO-1003", search_term: "unsecured business line of credit", match_type: "Phrase", campaign: "Lines of Credit - US", ad_group: "Revolving Lines", impressions: 18500, clicks: 1250, cost: 5120.00, conversions: 78, conversion_value: 54600.00 },
    { row_id: "DEMO-1004", search_term: "merchant cash advance bad credit", match_type: "Broad", campaign: "MCA - Fast Funding", ad_group: "Cash Advance", impressions: 22100, clicks: 1450, cost: 4890.00, conversions: 65, conversion_value: 32500.00 },
    { row_id: "DEMO-1005", search_term: "sba 7a loan lenders requirements", match_type: "Phrase", campaign: "SBA Loans - Evergreen", ad_group: "SBA 7(a)", impressions: 11200, clicks: 710, cost: 3100.00, conversions: 38, conversion_value: 76000.00 },
    { row_id: "DEMO-1006", search_term: "small business funding online fast", match_type: "Exact", campaign: "Working Capital - Core US", ad_group: "Fast Working Capital", impressions: 8400, clicks: 590, cost: 2150.00, conversions: 31, conversion_value: 18600.00 },
    { row_id: "DEMO-1007", search_term: "commercial fleet vehicle financing", match_type: "Phrase", campaign: "Equipment Finance - National", ad_group: "Vehicle Loans", impressions: 5600, clicks: 340, cost: 1420.00, conversions: 19, conversion_value: 28500.00 },
    { row_id: "DEMO-1008", search_term: "sba loan interest rates 2026", match_type: "Phrase", campaign: "SBA Loans - Evergreen", ad_group: "SBA Rates", impressions: 13400, clicks: 920, cost: 2950.00, conversions: 45, conversion_value: 67500.00 },
    { row_id: "DEMO-2001", search_term: "personal loan for debt consolidation", match_type: "Broad", campaign: "Working Capital - Core US", ad_group: "Broad General", impressions: 34000, clicks: 2100, cost: 6300.00, conversions: 0, conversion_value: 0.00 },
    { row_id: "DEMO-2002", search_term: "first time home buyer mortgage", match_type: "Exact", campaign: "Equipment Finance - National", ad_group: "General Real Estate", impressions: 15000, clicks: 820, cost: 2900.00, conversions: 0, conversion_value: 0.00 },
    { row_id: "DEMO-2003", search_term: "government small business grants free", match_type: "Phrase", campaign: "SBA Loans - Evergreen", ad_group: "Grants Search", impressions: 45000, clicks: 3800, cost: 9500.00, conversions: 2, conversion_value: 100.00 },
    { row_id: "DEMO-2004", search_term: "kestrel business funding careers jobs", match_type: "Exact", campaign: "Brand Campaign", ad_group: "Brand Hiring", impressions: 2400, clicks: 450, cost: 450.00, conversions: 0, conversion_value: 0.00 },
    { row_id: "DEMO-2005", search_term: "used car loan calculator", match_type: "Broad", campaign: "Equipment Finance - National", ad_group: "Auto Loans", impressions: 12000, clicks: 730, cost: 1800.00, conversions: 0, conversion_value: 0.00 },
    { row_id: "DEMO-2006", search_term: "student loan forgiveness application", match_type: "Phrase", campaign: "SBA Loans - Evergreen", ad_group: "Student Loans", impressions: 19000, clicks: 1100, cost: 3100.00, conversions: 0, conversion_value: 0.00 },
    { row_id: "DEMO-3001", search_term: "business bank account bonus offer", match_type: "Broad", campaign: "Working Capital - Core US", ad_group: "Banking Offers", impressions: 16500, clicks: 1120, cost: 4200.00, conversions: 3, conversion_value: 450.00 },
    { row_id: "DEMO-3002", search_term: "how to calculate cash flow ratio", match_type: "Phrase", campaign: "Working Capital - Core US", ad_group: "Educational Content", impressions: 8900, clicks: 680, cost: 1600.00, conversions: 1, conversion_value: 150.00 },
    { row_id: "DEMO-3003", search_term: "invoice factoring vs working capital", match_type: "Phrase", campaign: "Working Capital - Core US", ad_group: "Comparison", impressions: 4500, clicks: 310, cost: 980.00, conversions: 4, conversion_value: 3200.00 },
    { row_id: "DEMO-3004", search_term: "restaurant startup capital planning", match_type: "Broad", campaign: "Working Capital - Core US", ad_group: "Startup Funding", impressions: 7800, clicks: 520, cost: 1850.00, conversions: 5, conversion_value: 6500.00 },
    { row_id: "DEMO-4001", search_term: "kestrel funding phone number hours", match_type: "Exact", campaign: "Brand Campaign", ad_group: "Brand Info", impressions: 850, clicks: 120, cost: 45.00, conversions: 12, conversion_value: 12000.00 },
    { row_id: "DEMO-4002", search_term: "kestrel business login portal", match_type: "Exact", campaign: "Brand Campaign", ad_group: "Brand Login", impressions: 1400, clicks: 310, cost: 62.00, conversions: 25, conversion_value: 35000.00 },
    { row_id: "DEMO-4003", search_term: "commercial lending office chicago il", match_type: "Phrase", campaign: "Equipment Finance - National", ad_group: "Local Office", impressions: 620, clicks: 45, cost: 28.00, conversions: 2, conversion_value: 2400.00 }
  ];

  const settings = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
  return terms.map(t => analyzeSearchTerm(t, settings));
}

startServer();
