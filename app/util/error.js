/** dynamically added error */
const error = (app) => {
  app.use((req, res) => {
    const status = 405;
    const message = error.message;
    const data = error.data || 'Method Not Allowed!';
    res.status(status).json({
      statusCode: status,
      message: message,
      error: data
    });
  });
};
export default error;
