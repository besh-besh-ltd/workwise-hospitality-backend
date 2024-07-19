/** CORS meta data added to the server */

const origin = (app) => {
  app.use((req, res, next) => {
    const allowedOrigins = [
      'http://localhost:3000',
      'http://localhost::8101',
      'http://143.110.242.57:8101',
      'http://143.110.242.57:8099',
      'https://51697dpc-8101.inc1.devtunnels.ms'
    ];
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('app_version', '*');
    res.setHeader('Access-Control-Allow-Credentials', 'true');
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
