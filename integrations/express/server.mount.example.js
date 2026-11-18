// Add this block to the existing backend/server.js after environment loading
// and Express middleware, before any catch-all route. Keep the rest of server.js.
// The CRM route checks its own Bearer key; do not wrap it in user-login middleware.
app.use('/api/crm/v1', require('./routes/crm_integration.route.js'));
