import Joi from 'joi';
import { validateBody } from './userValidation.js';

/**
 * Admin password rules are deliberately stricter than the user-side ones.
 *
 * `schemas.change_password` in userValidation.js accepts `min(3).max(15)`,
 * which permits "abc" on an account that can read every tenant's data. The cap
 * is 72 because bcrypt hashes only the first 72 bytes and silently ignores the
 * rest — a longer maximum would advertise strength the hash cannot store.
 */
const ADMIN_PASSWORD = Joi.string()
  .min(10)
  .max(72)
  .pattern(/[a-z]/, 'a lowercase letter')
  .pattern(/[A-Z]/, 'an uppercase letter')
  .pattern(/[0-9]/, 'a number')
  .required()
  .label('Password')
  .messages({
    'string.min': 'Password must be at least 10 characters',
    'string.max': 'Password must be 72 characters or fewer',
    'string.pattern.name': 'Password must contain {{#name}}'
  });

const CONFIRM_PASSWORD = Joi.any()
  .valid(Joi.ref('password'))
  .required()
  .messages({
    'any.only': 'Password and Confirm password not matched'
  });

export const adminAuthSchemas = {
  change_password: Joi.object().keys({
    current_password: Joi.string().max(72).required().label('Current password'),
    password: ADMIN_PASSWORD,
    confirm_password: CONFIRM_PASSWORD
  }),

  forgot_password: Joi.object().keys({
    /**
     * `tlds: { allow: false }` disables Joi's IANA TLD allowlist, keeping the
     * structural check (a local part, an @, a domain) and dropping the
     * "is this a real top-level domain" one.
     *
     * Two reasons. Corporate and internal domains are legitimate for admin
     * accounts on a B2B product and the allowlist rejects them — the repo's own
     * fixtures are all @test.local, which the default rules refuse. And the
     * check buys nothing here: this endpoint answers identically whether or not
     * the address matches an admin, so an unparseable address is already
     * indistinguishable from an unknown one.
     */
    email: Joi.string()
      .email({ tlds: { allow: false } })
      .max(100)
      .required()
      .label('Email')
  }),

  reset_password: Joi.object().keys({
    token: Joi.string().hex().length(64).required().label('Reset token'),
    password: ADMIN_PASSWORD,
    confirm_password: CONFIRM_PASSWORD
  })
};

export { validateBody };
