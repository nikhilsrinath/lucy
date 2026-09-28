import React, { createContext, useContext, useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';
import { useAuth } from './AuthContext';
import { orgStore } from '../services/orgStore';
import { createOrganization as provisionOrganization } from '../services/orgProvisioning';

export const OrgContext = createContext({});

export const OrgProvider = ({ children }) => {
  const { user, needsOnboarding } = useAuth();
  const [organizations, setOrganizations] = useState([]);
  const [activeOrg, setActiveOrg] = useState(null);
  const [loading, setLoading] = useState(true);

  // Keyed on the user's id, not the user object: Supabase hands back a new
  // object on every token refresh and profile update (the chosen cofounder is
  // saved to user_metadata), and each one used to reload every organization.
  const userId = user?.id || null;
  useEffect(() => {
    if (userId && !needsOnboarding) {
      fetchOrganizations();
    } else {
      setOrganizations([]);
      setActiveOrg(null);
      orgStore.clear();
      setLoading(false);
    }
  }, [userId, needsOnboarding]);

  // One query replaces the previous four-source fallback (localStorage, the
  // Firestore `memberships` collection, the `users/{uid}.organizations` map and
  // the legacy RTDB path), which existed because those sources disagreed.
  // RLS scopes `memberships` to the caller, so no user_id filter is needed.
  const fetchOrganizationIds = async () => {
    const { data, error } = await supabase
      .from('memberships')
      .select('org_id')
      .order('created_at', { ascending: true });

    if (error) throw error;
    return (data || []).map((row) => row.org_id);
  };

  const fetchOrganizations = async () => {
    setLoading(true);
    try {
      const organizationIds = await fetchOrganizationIds();

      // No membership means no organization. There is no "local workspace"
      // fallback any more: it minted `local_${uid}` ids that are not UUIDs and
      // fail every foreign key. An orgless user belongs in onboarding, which
      // AuthContext.needsOnboarding already routes to.
      if (organizationIds.length === 0) {
        setOrganizations([]);
        setActiveOrg(null);
        return;
      }

      const orgs = [];
      for (const orgId of organizationIds) {
        await orgStore.load(orgId);
        const profile = orgStore.getProfile();
        if (profile && Object.keys(profile).length > 0) {
          orgs.push({
            id: orgId,
            name: profile.company_name || 'Untitled Organization',
            ...profile,
          });
        }
      }

      setOrganizations(orgs);
      if (orgs.length > 0) {
        setActiveOrg(orgs[0]);
        // Leave orgStore pointed at the active org, not the last one loaded.
        await orgStore.load(orgs[0].id);
      }
    } catch (err) {
      console.warn('Could not fetch organizations:', err);
      setOrganizations([]);
      setActiveOrg(null);
    } finally {
      setLoading(false);
    }
  };

  const createOrganization = async (name) => {
    const orgId = await provisionOrganization(name, {
      company_name: name,
      company_email: user?.email || '',
    });

    await orgStore.load(orgId);
    const profile = orgStore.getProfile();
    const org = { id: orgId, name: profile?.company_name || name, ...profile };

    setOrganizations((prev) => [...prev, org]);
    setActiveOrg(org);
    return org;
  };

  const updateOrganization = async (orgId, updates) => {
    await orgStore.updateProfile(updates);
    const updatedOrg = {
      ...(activeOrg || {}),
      id: orgId,
      name: updates.company_name || activeOrg?.name || activeOrg?.company_name || 'Untitled Organization',
      ...updates,
    };
    setActiveOrg(updatedOrg);
    setOrganizations((prev) => prev.map((org) => (org.id === orgId ? { ...org, ...updatedOrg } : org)));
  };

  return (
    <OrgContext.Provider value={{ organizations, activeOrg, setActiveOrg, loading, createOrganization, updateOrganization, fetchOrganizations }}>
      {children}
    </OrgContext.Provider>
  );
};

export const useOrg = () => useContext(OrgContext);
