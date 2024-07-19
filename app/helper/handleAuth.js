import JWT from 'jsonwebtoken';
import Config from '../config/app.config.js';
const handle_auth = {
  common_handle_auth_admin: async (req, res, next) => {
    // console.log("User detls --", req.user);
    // if (req.get('User-Agent') == req.user.ag) {
    if (req.user && req.user.role_id == 1) {
      next();
    } else {
      let return_err = { status: 5, message: 'Unauthorized' };
      return res.status(401).json(return_err);
    }
    // } else {
    //     let return_err = { status: 5, message: 'Unauthorized' };
    //     return res.status(401).json(return_err);
    // }
  }
};

export default handle_auth;
