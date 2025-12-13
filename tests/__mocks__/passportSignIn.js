export default function passportSignIn(req, res, next) {
  req.user = { id: 999, name: "Test User" };  
  next();
}
