import JWT from 'jsonwebtoken';
import Config from '../config/app.config.js';

const jwtHelper = {
  /** Generate access token using JWT */
  signAccessToken: (userData) => {
    return JWT.sign(
      {
        iss: 'Des Technico',
        sub: userData.user_id,
        name: userData.name,
        admin: true,
        ag: userData.user_agent,
        iat: Math.round(new Date().getTime() / 1000),
        exp: Math.round(new Date().getTime() / 1000) + 24 * 60 * 60
        // exp: Math.round(new Date().getTime() / 1000) + 20
      },
      Config.jwt.secret
    );
  },
  signAccessTokenUser: (userData) => {
    return JWT.sign(
      {
        iss: 'Des Technico',
        sub: userData.user_id,
        name: userData.name,
        session: userData.sessions,
        user: true,
        ag: userData.user_agent,
        iat: Math.round(new Date().getTime() / 1000),
        exp: Math.round(new Date().getTime() / 1000) + 24 * 60 * 60
        // exp: Math.round(new Date().getTime() / 1000) + 10
      },
      Config.jwt.secret
    );
  }
};

export default jwtHelper;
