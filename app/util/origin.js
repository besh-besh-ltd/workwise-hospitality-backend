/** CORS meta data added to the server */

const origin = (app) => {
  app.use((req, res, next) => {
    const allowedOrigins = [
      'http://localhost:3000',
      'http://localhost::8101',
      'http://143.110.242.57:8101',
      'http://143.110.242.57:8099',
      'https://51697dpc-8101.inc1.devtunnels.ms',
      'http://13.127.220.219:3000',
      'http://13.126.141.212:3000',
      'http://test.workwise.42web.io',
      'http://admin-test.workwise.42web.io',
      'http://admin.letsworkwise.com',
      'http://www.letsworkwise.com',
      'http://letsworkwise.com'

    ];
    // Access-Control-Allow-Origin / -Credentials are owned by the cors()
    // middleware (corsOptions.js). Setting '*' here would defeat the
    // CORS_ORIGINS allowlist for every non-matching origin.
    res.setHeader('app_version', '*');
    res.setHeader(
      'Access-Control-Allow-Methods',
      'OPTIONS, GET, POST, PUT, PATCH, DELETE'
    );
    res.setHeader(
      'Access-Control-Allow-Headers',
      'Content-Type, Authorization, LoginType, RefererUrl, AccessToken, appVersion'
    );
    next();
  });
};
export default origin;
