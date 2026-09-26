import { Navigate, useLocation, useParams } from 'react-router-dom';
import { legacyAgenciesTarget } from '@/lib/builderAgency';

/**
 * The old Agencies section, kept as addresses so no bookmark or shared link
 * breaks: its Messages tab opens the agency conversations on Messages (with
 * the conversation it named), and everything else opens Agency Activations.
 */
export default function LegacyAgenciesRedirect() {
  const { tab } = useParams<{ tab?: string }>();
  const { search } = useLocation();
  return <Navigate to={legacyAgenciesTarget(tab, search)} replace />;
}
