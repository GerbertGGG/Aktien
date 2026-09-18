export const API_BASE_URI = "https://timetreeapp.com/api/v1";
// The real web app's GET /calendars call (confirmed via a live browser
// capture) is actually served from v2, not v1 - unclear yet whether other
// endpoints (labels, events/sync) have also moved; those still use
// API_BASE_URI until proven otherwise.
export const API_V2_BASE_URI = "https://timetreeapp.com/api/v2";
export const API_USER_AGENT = "web/2.1.0/de";
