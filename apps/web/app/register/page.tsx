import { redirect } from 'next/navigation';

/** Legacy bookmarks cannot expose an alternative authentication flow. */
export default function LegacyAuthenticationPage() { redirect('/login'); }
