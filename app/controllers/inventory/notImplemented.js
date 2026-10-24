/** Placeholder handler for inventory routes whose owning task has not landed. */
export const notImplemented = (req, res) =>
  res.status(501).json({ status: 0, message: 'not implemented' });
