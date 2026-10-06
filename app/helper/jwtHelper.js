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
  /** userData.user_id, user_agent and (optional) ent must already be encrypted.
   *  `ent` is the Vendor Networks acting entity (spec §4.1); omitted = act as default.
   *  `exp` (unix seconds) keeps a re-issued token on its original session lifetime;
   *  omitted = 24h from now. */
  signAccessTokenUser: (userData) => {
    return JWT.sign(
      {
        iss: 'Des Technico',
        sub: userData.user_id,
        name: userData.name,
        session: userData.sessions,
        user: true,
        ag: userData.user_agent,
        ...(userData.ent ? { ent: userData.ent } : {}),
        iat: Math.round(new Date().getTime() / 1000),
        exp: userData.exp ?? Math.round(new Date().getTime() / 1000) + 24 * 60 * 60
        // exp: Math.round(new Date().getTime() / 1000) + 10
      },
      Config.jwt.secret
    );
  },

  /** Generate a short-lived JWT for guest/token-based vendor access.
   *  userData.user_id and userData.user_agent must already be encrypted. */
  signGuestAccessToken: (userData, expirySeconds = 1800) => {
    return JWT.sign(
      {
        iss: 'Des Technico',
        sub: userData.user_id,
        name: userData.name,
        ag: userData.user_agent,
        user: true,
        guest: true,
        iat: Math.round(new Date().getTime() / 1000),
        exp: Math.round(new Date().getTime() / 1000) + expirySeconds,
      },
      Config.jwt.secret
    );
  }
};

export default jwtHelper;
