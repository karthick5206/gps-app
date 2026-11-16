import { createContext, useContext } from 'react';
import { PHOTO_FEATURES_OFF, type Action, type LoginResponse, type Me, type MenuKey, type PhotoFeatures } from '@veetracer/shared';

export const meQueryKey = (companyId: string | null) => ['me', companyId] as const;

export type AuthStatus = 'loading' | 'authenticated' | 'anonymous';

export interface AuthContextValue {
  status: AuthStatus;
  me: Me | undefined;
  companyId: string | null;
  signIn: (res: LoginResponse) => void;
  signOut: () => void;
  switchCompany: (companyId: string | null) => void;
  can: (menu: MenuKey, action?: Action) => boolean;
}

export const AuthContext = createContext<AuthContextValue | null>(null);

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>');
  return ctx;
}

/** The signed-in user's profile; only valid inside protected routes. */
export function useMe(): Me {
  const { me } = useAuth();
  if (!me) throw new Error('useMe used outside an authenticated route');
  return me;
}

export function useCan() {
  return useAuth().can;
}

/** The acting company's photo feature switches (default off; Settings → Features). */
export function usePhotoFeatures(): PhotoFeatures {
  return useAuth().me?.company.photoFeatures ?? PHOTO_FEATURES_OFF;
}
