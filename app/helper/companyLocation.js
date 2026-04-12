const normalizeNullableString = (value) => {
  if (value === undefined || value === null) return null;
  const normalized = String(value).trim();
  return normalized || null;
};

const normalizeNullableId = (value) => {
  if (value === undefined || value === null || value === '') return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isNaN(parsed) ? null : parsed;
};

export const buildPrimaryCompanyLocationPayload = (
  { address, country, state, city, postal_code } = {},
  actorId = null
) => {
  const payload = {
    address: normalizeNullableString(address),
    country_id: normalizeNullableId(country),
    state_id: normalizeNullableId(state),
    city_id: normalizeNullableId(city),
    postal_code: normalizeNullableString(postal_code),
    created_by: actorId,
    updated_by: actorId
  };

  const hasLocationData = Boolean(
    payload.address ||
      payload.country_id !== null ||
      payload.state_id !== null ||
      payload.city_id !== null ||
      payload.postal_code
  );

  return hasLocationData ? payload : null;
};

export const formatCompanyLocationDisplay = (location = null, fallbackAddress = null) => {
  const address = normalizeNullableString(location?.address) || normalizeNullableString(fallbackAddress);
  const parts = [
    address,
    normalizeNullableString(location?.city_name),
    normalizeNullableString(location?.state_name),
    normalizeNullableString(location?.postal_code),
    normalizeNullableString(location?.country_name)
  ].filter(Boolean);

  return parts.length ? parts.join(', ') : null;
};

export { normalizeNullableId, normalizeNullableString };
