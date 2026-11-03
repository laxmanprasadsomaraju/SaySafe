import { Navigate, useLocation } from 'react-router-dom';

/**
 * /guide is the old address of "How to use SaySafe". It now lives in the Help centre at /help.
 * Kept as a redirect because shared links (web/src/lib/shareText.ts) and older pages point here.
 */
export default function Guide() {
  const { hash } = useLocation();
  return <Navigate to={`/help${hash || '#getting-started'}`} replace />;
}
