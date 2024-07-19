/** dynamically added error */
const error = (app) => {
  app.use((req, res) => {
    const status = error.statusCode || 500;
    const message = error.message;
    const data = error.data || '!!Error';
    res.status(status).json({
      statusCode: status,
      message: message,
      error: data
    });
  });
};
export default error;
