import { useState, useEffect } from 'react';
import { Routes, Route, useNavigate, useLocation, Navigate, useParams, useSearchParams } from 'react-router-dom';
import {
  LayoutDashboard, Briefcase, Award, Scale, ShieldCheck,
  Layers, Archive, Users,
  UploadCloud, FileCheck, FileSignature, History,
  Activity, Receipt, FilePlus, RotateCcw,
  GitBranch, UserX, Kanban, Package,
  Truck, FileInput, TrendingUp, CalendarCheck, Plane, Megaphone,
  BrainCircuit, Banknote, FolderKanban, ListChecks, PieChart, Clock, FolderOpen,
  Wallet, BarChart3, UsersRound, FileStack, Gauge
} from 'lucide-react';
import SubPage from './components/landing/SubPage';
import subPages from './components/landing/subPageData';

import OfferForm from './components/OfferForm';
import InternRecords from './components/InternRecords';
import DocumentLibrary from './components/library/DocumentLibrary';
import CertificateForm from './components/CertificateForm';
import NdaForm from './components/NdaForm';
import MoUForm from './components/MoUForm';
import InvoiceForm from './components/InvoiceForm';
import Overview from './components/overview/Overview';
import FinanceDash from './components/overview/FinanceDash';
import SalesDash from './components/overview/SalesDash';
import TeamDash from './components/overview/TeamDash';
import ProjectsDash from './components/overview/ProjectsDash';
import DocumentsDash from './components/overview/DocumentsDash';
import UsageDash from './components/overview/UsageDash';
import ModuleShell from './components/shell/ModuleShell';
import Customers from './components/Customers';
import BillingRevenue from './components/BillingRevenue';
import ProductPlanner from './components/ProductPlanner';
import Products from './components/Products';
import CompanyProfile from './components/CompanyProfile';
import { AuthProvider, useAuth } from './context/AuthContext';
import { OrgProvider, useOrg } from './context/OrgContext';
import CRM from './components/CRM';
import Employees from './components/Employees';
import EmployeeForm from './components/EmployeeForm';
import ExEmployees from './components/ExEmployees';
import TeamHierarchy from './components/TeamHierarchy';
import TasksPage from './components/tasks/TasksPage';
import ProjectsPage from './components/projects/ProjectsPage';
import ProjectForm from './components/projects/ProjectForm';
import ProjectDetail from './components/projects/ProjectDetail';
import Portfolio from './components/projects/Portfolio';
import Timesheets from './components/projects/Timesheets';
import { AssistantProvider } from './components/assistant/AssistantContext';
import ChatScreen from './chat/ChatScreen';
import HomeScreen from './home/HomeScreen';
import BusinessScreen from './business/BusinessScreen';
import MoneyScreen from './money/MoneyScreen';
import ClientsScreen from './clients/ClientsScreen';
import WorkScreen from './work/WorkScreen';
import TeamScreen from './team/TeamScreen';
import SettingsScreen from './settings/SettingsScreen';
import ShellProvider from './shell/ShellProvider';
import { useCofounder } from './design/useCofounder';
import { IconChevronLeft } from './design/icons';
import './design/docEditor.css';
import Onboarding, { Welcome, SignIn } from './onboarding/Onboarding';
import { onboardingStep } from './onboarding/onboardingState';
import EdgeBrain from './components/brain/EdgeBrain';
import { useTaskDeadlineMonitor } from './hooks/useTaskDeadlineMonitor';
import AppShell from './shell/AppShell';
import { LEGACY_PAGES, sectionOf } from './shell/sections';
import { resolveLegacyPath } from './shell/redirects';

import BulkOfferLetters from './components/bulk/BulkOfferLetters';
import BulkCertificates from './components/bulk/BulkCertificates';
import BulkTeamMembers from './components/bulk/BulkTeamMembers';
import OfferTracker from './components/OfferTracker';
import BulkHistory from './components/bulk/BulkHistory';
import RecipientPortal from './components/portal/RecipientPortal';
import './portal/portalTheme.css';
import EmployeePortal from './components/portal/EmployeePortal';
import JoinPortal from './components/portal/JoinPortal';
import AttendanceSheet from './components/people/AttendanceSheet';
import LeaveRequests from './components/people/LeaveRequests';
import Announcements from './components/people/Announcements';
import { meService } from './services/meService';
import { ToastProvider } from './components/shared/Toast';
import ConfirmHost from './components/shared/ConfirmHost';
import AdminApp from './components/admin/AdminApp';

// Financial Documents
import QuotationForm from './components/financial/QuotationForm';
import ProformaInvoiceForm from './components/financial/ProformaInvoiceForm';
import FinanceStatus from './components/financial/FinanceStatus';
import Vendors from './components/financial/Vendors';
import PurchaseInvoices from './components/financial/PurchaseInvoices';
import CashBook from './components/financial/CashBook';
import TaxSummary from './components/financial/TaxSummary';
import ProfitLoss from './components/financial/ProfitLoss';
import InvoiceList from './components/financial/InvoiceList';
import { RecurringInvoiceForm, RecurringInvoiceList } from './components/financial/RecurringInvoiceForm';
import { documentStore, docNumber } from './services/documentStore';



const MODULE_FILTER = {
  overall: ['dashboard', 'dashboard/finance', 'dashboard/sales', 'dashboard/team', 'dashboard/projects',
            'dashboard/documents', 'dashboard/usage'],
  brain: ['edgebrain'],
  team: ['team-hierarchy', 'employees', 'offer-tracker', 'ex-employees', 'bulk-team',
         'attendance', 'leave', 'announcements'],
  // Tasks moved here from Team: work belongs to the thing being delivered.
  // Portfolio (Phase 2) and Timesheets (Phase 3) join the rail when they ship.
  projects: ['projects', 'tasks', 'portfolio', 'timesheets'],
  documents: ['records', 'library', 'offers', 'new-certificates', 'certificates', 'ndas', 'mous', 'bulk-offers', 'bulk-certificates', 'bulk-history'],
  finance: ['finance-status', 'cashbook', 'invoices', 'quotations', 'proforma', 'recurring', 'vendors', 'purchases', 'tax-summary', 'profit-loss'],
  business: ['crm', 'customers', 'products', 'planner'],
};

// Pages that belong to a module without having a place in its rail — the
// editors reached from a list. They still wear that module's frame.
const MODULE_EXTRA_PAGES = {
  finance: ['new-invoice', 'new-quotation', 'new-proforma'],
  projects: ['project-detail', 'new-project'],
};

// Pages whose content manages its own scrolling edge to edge: the org chart's
// canvas and the form-beside-preview document editors.
const FLUSH_PAGES = new Set([
  'team-hierarchy', 'offers', 'new-certificates', 'certificates', 'ndas', 'mous',
  'new-invoice', 'new-quotation', 'new-proforma',
  'edgebrain',
]);

const MODULE_META = {
  brain:     { id: 'brain', label: 'EdgeBrain' },
  team:      { id: 'team', label: 'Team' },
  documents: { id: 'documents', label: 'Documents' },
  finance:   { id: 'finance', label: 'Finance' },
  business:  { id: 'business', label: 'Client Management' },
  projects:  { id: 'projects', label: 'Projects' },
  overall:   { id: 'overall', label: 'Dashboard' },
};

const NAV_ITEMS = [
  // `end`: /dashboard must not also light up on /dashboard/finance.
  { id: 'dashboard', label: 'Overview', icon: LayoutDashboard, end: true },
  { id: 'dashboard/finance', label: 'Finance', icon: Wallet },
  { id: 'dashboard/sales', label: 'Sales & Clients', icon: BarChart3 },
  { id: 'dashboard/team', label: 'Team', icon: UsersRound },
  { id: 'dashboard/projects', label: 'Projects', icon: FolderKanban },
  { id: 'dashboard/documents', label: 'Documents', icon: FileStack },
  { id: 'dashboard/usage', label: 'Usage', icon: Gauge },
  { section: 'EDGEBRAIN' },
  { id: 'edgebrain', label: 'Company Brain', icon: BrainCircuit },
  { section: 'TEAM' },
  { id: 'team-hierarchy', label: 'Team Hierarchy', icon: GitBranch },
  { id: 'employees', label: 'Employees', icon: Users },
  { id: 'offer-tracker', label: 'Recruitment Tracker', icon: Activity },
  { id: 'ex-employees', label: 'Ex-Employees', icon: UserX },
  { section: 'PEOPLE OPS' },
  { id: 'attendance', label: 'Attendance', icon: CalendarCheck },
  { id: 'leave', label: 'Leave', icon: Plane },
  { id: 'announcements', label: 'Announcements', icon: Megaphone },
  { section: 'DOCUMENTS' },
  { id: 'records', label: 'Records', icon: Archive },
  { id: 'library', label: 'General Documents', icon: FolderOpen },
  { id: 'offers', label: 'Offer Letters', icon: Briefcase },
  { id: 'new-certificates', label: 'Certificates', icon: Award },
  { id: 'ndas', label: 'NDA', icon: ShieldCheck },
  { id: 'mous', label: 'MoU', icon: Scale },
  { section: 'FINANCE' },
  { id: 'finance-status', label: 'Finance Status', icon: Activity },
  { id: 'cashbook', label: 'Cash Book', icon: Banknote },
  { id: 'invoices', label: 'Invoices', icon: Receipt },
  { id: 'quotations', label: 'Quotations', icon: FilePlus },
  { id: 'proforma', label: 'Proforma Invoice', icon: FileCheck },
  { id: 'recurring', label: 'Recurring', icon: RotateCcw },
  { id: 'vendors', label: 'Vendors', icon: Truck },
  { id: 'purchases', label: 'Purchase Bills', icon: FileInput },
  { id: 'tax-summary', label: 'Tax Summary', icon: Scale },
  { id: 'profit-loss', label: 'Profit & Loss', icon: TrendingUp },
  { section: 'BUSINESS' },
  { id: 'crm', label: 'CRM', icon: Kanban },
  { id: 'customers', label: 'Client Directory', icon: Users },
  { id: 'products', label: 'Products', icon: Package },
  { id: 'planner', label: 'Product Planner', icon: Layers },
  { section: 'PROJECTS' },
  { id: 'projects', label: 'Projects', icon: FolderKanban },
  { id: 'tasks', label: 'Tasks', icon: ListChecks },
  { id: 'portfolio', label: 'Portfolio', icon: PieChart },
  { id: 'timesheets', label: 'Timesheets', icon: Clock },
  { section: 'BULK OPERATIONS' },
  { id: 'bulk-offers', label: 'Bulk Offers', icon: UploadCloud },
  { id: 'bulk-certificates', label: 'Bulk Certificates', icon: FileCheck },
  { id: 'bulk-team', label: 'Bulk Team Members', icon: FileSignature },
  { id: 'bulk-history', label: 'Bulk History', icon: History },
];

const PAGE_META = {
  edgebrain: { title: 'EdgeBrain', subtitle: 'Your company, organised as one connected context your AI can reason over' },
  dashboard: { title: 'Dashboard', subtitle: 'The whole organisation, one period — click anything for the analysis behind it' },
  'dashboard/finance': { title: 'Finance dashboard', subtitle: 'Money in, money out, and who owes whom' },
  'dashboard/sales': { title: 'Sales & clients', subtitle: 'Pipeline, quotations, customers, products and markets' },
  'dashboard/team': { title: 'Team dashboard', subtitle: 'Headcount, attendance, leave and who is carrying the work' },
  'dashboard/projects': { title: 'Projects dashboard', subtitle: 'What is being delivered, what is late, and whether it pays' },
  'dashboard/documents': { title: 'Documents dashboard', subtitle: 'Everything issued, every reply, and the library EdgeBrain reads' },
  'dashboard/usage': { title: 'Usage', subtitle: 'AI messages and plan limits — how much you have used and what is left' },
  profile: { title: 'Company Profile', subtitle: 'The details every document you issue is signed with' },
  offers: { title: 'Offer Letters', subtitle: 'Generate employment and internship offers' },
  'new-certificates': { title: 'Certificates', subtitle: 'Issue professional attainment certificates' },
  certificates: { title: 'Certificates', subtitle: 'Issue professional attainment certificates' },
  ndas: { title: 'Non-Disclosure Agreements', subtitle: 'Draft legal-grade confidentiality agreements' },
  mous: { title: 'Memorandum of Understanding', subtitle: 'Establish collaboration frameworks and partnerships' },
  'finance-status': { title: 'Finance Status', subtitle: 'Track all financial documents through their lifecycle' },
  cashbook: { title: 'Cash Book', subtitle: 'Record money in and money out — everything no invoice or vendor bill already covers' },
  invoices: { title: 'Invoices', subtitle: 'View and manage your invoices' },
  quotations: { title: 'Quotations', subtitle: 'View and manage your quotations' },
  proforma: { title: 'Proforma Invoices', subtitle: 'View and manage your proforma invoices' },
  recurring: { title: 'Recurring Invoices', subtitle: 'Set up and manage recurring invoices' },
  vendors: { title: 'Vendors', subtitle: 'Suppliers, payment terms and what you owe each of them' },
  purchases: { title: 'Purchase Bills', subtitle: 'Bills received from vendors — money out as a tracked payable' },
  'tax-summary': { title: 'Tax Summary', subtitle: 'Output GST against input GST — a preparation aid, not a filing tool' },
  'profit-loss': { title: 'Profit & Loss', subtitle: 'Income, expenses and net profit for any period' },
  'new-invoice': { title: 'New Invoice', subtitle: 'Generate professional business invoices' },
  'new-quotation': { title: 'New Quotation', subtitle: 'Create a quotation for your client' },
  'new-proforma': { title: 'New Proforma Invoice', subtitle: 'Create proforma invoices with advance payment tracking' },
  crm: { title: 'CRM', subtitle: 'Manage your sales pipeline' },
  customers: { title: 'Client Directory', subtitle: 'Manage your client database' },
  products: { title: 'Products', subtitle: 'Product and service catalogue, and what each one has sold' },
  revenue: { title: 'Billing & Revenue', subtitle: 'Track revenue, expenses, and profitability' },
  planner: { title: 'Product Planner', subtitle: 'Plan and track products and projects' },
  records: { title: 'Records', subtitle: 'Manage and download issued documents' },
  library: { title: 'General Documents', subtitle: 'Any file the company keeps — read by EdgeBrain so the AI can answer from it' },
  employees: { title: 'Employee Registry', subtitle: 'Manage your internal team and onboarding' },
  'ex-employees': { title: 'Ex-Employees', subtitle: 'Archive of employees who have left the organization' },
  me: { title: 'My Portal', subtitle: 'Your attendance, leave and announcements' },
  attendance: { title: 'Attendance', subtitle: 'Daily sheet, monthly calendar and export' },
  leave: { title: 'Leave', subtitle: 'Approve requests, track balances and set quotas' },
  announcements: { title: 'Announcements', subtitle: 'Broadcast to the whole team or one department' },
  'team-hierarchy': { title: 'Team Hierarchy', subtitle: 'Visual org chart — drag nodes and connect reporting lines' },
  'offer-tracker': { title: 'Recruitment Tracker', subtitle: 'Real-time acceptance status for all sent offer letters' },
  'bulk-offers': { title: 'Bulk Offer Letters', subtitle: 'Generate and distribute multiple offer letters at once' },
  'bulk-certificates': { title: 'Bulk Certificates', subtitle: 'Issue batches of certificates efficiently' },
  'bulk-team': { title: 'Bulk Team Members', subtitle: 'Import your team registry from a CSV file' },
  'bulk-history': { title: 'Bulk History', subtitle: 'Track and review past bulk generation jobs' },
  tasks: { title: 'Tasks', subtitle: 'Assign and track work — by project, or General' },
  projects: { title: 'Projects', subtitle: 'What the company is delivering, for whom, and whether it pays' },
  'new-project': { title: 'New project', subtitle: 'Client or internal work, its team, budget and plan' },
  'project-detail': { title: 'Project', subtitle: 'Money in, money out, people, plan and work' },
  portfolio: { title: 'Portfolio', subtitle: 'Every project: health, margin and team load' },
  timesheets: { title: 'Timesheets', subtitle: 'Hours by person and project — submitted, approved, billed' },
};

function AppContent() {
  const location = useLocation();
  const routerNavigate = useNavigate();
  useTaskDeadlineMonitor();

  let activePage = location.pathname.substring(1);
  if (activePage === '') activePage = 'hub';
  let editingDocId = null;
  if (activePage.startsWith('new-quotation/')) {
    editingDocId = activePage.split('/')[1];
    activePage = 'new-quotation';
  } else if (activePage === 'bulk-offers') activePage = 'bulk-offers';
  else if (activePage === 'bulk-certificates') activePage = 'bulk-certificates';
  else if (activePage === 'bulk-team') activePage = 'bulk-team';
  else if (activePage === 'bulk-history') activePage = 'bulk-history';
  else if (activePage === 'projects/new') activePage = 'new-project';
  else if (activePage.startsWith('dashboard/')) activePage = activePage.replace(/\/+$/, '');
  else if (activePage.startsWith('projects/')) activePage = 'project-detail';
  else if (activePage.includes('/')) activePage = activePage.split('/')[0];

  let activeModule = null;
  for (const [mod, pages] of Object.entries(MODULE_FILTER)) {
    if (pages.includes(activePage) || MODULE_EXTRA_PAGES[mod]?.includes(activePage)) {
      activeModule = mod;
      break;
    }
  }

  const { user, loading, logout, needsOnboarding } = useAuth();
  const { activeOrg } = useOrg();
  const { persona } = useCofounder();

  // One theme (D10). The older pages read data-theme from <html>; pinning it
  // keeps them light inside the new frame whatever an old toggle left behind.
  useEffect(() => { document.documentElement.setAttribute('data-theme', 'light'); }, []);

  // The documents cache the finance pages and the nav counts read. This used
  // to happen inside the (now removed) buildEdgeContext effect, whose only
  // other product — the legacy co-founder's figures — nothing read: the
  // assistant takes nothing from it but the org id.
  useEffect(() => {
    if (!activeOrg?.id) return;
    documentStore.setContext(activeOrg.id);
    documentStore.init().catch(() => { /* the pages that need it retry */ });
  }, [activeOrg?.id]);

  // An `employee` (0029) holds no org-wide permission at all — their access is
  // to their own attendance and leave rows. Rendering the admin shell for them
  // would be a sidebar of screens that all come back empty, so they get the
  // portal instead. This is presentation only: the RLS policies are what
  // actually stop them reading the rest of the organization.
  // undefined = not yet known, which is why the load gate below waits on it.
  const [myRole, setMyRole] = useState(undefined);
  useEffect(() => {
    let cancelled = false;
    Promise.resolve(user && activeOrg?.id ? meService.getMyRole(activeOrg.id) : null)
      .then((r) => { if (!cancelled) setMyRole(r); })
      .catch(() => { if (!cancelled) setMyRole(null); });
    return () => { cancelled = true; };
  }, [user, activeOrg?.id]);
  if (loading) {
    return (
      <div className="app-loading">
        <div style={{ textAlign: 'center' }}>
          <div className="app-loading-spinner" />
          <span className="app-loading-text">Loading StartupBuddy…</span>
        </div>
      </div>
    );
  }

  if (!user) {
    const pathname = location.pathname;
    if (pathname === '/login') return <SignIn />;
    if (pathname === '/signup') return <Onboarding initial="account" />;
    return <Welcome />;
  }

  // Signed in with no company yet (a Google sign-up): name the company.
  if (needsOnboarding) return <Onboarding initial="company" />;

  // Company created, onboarding not finished: resume where it stopped.
  const resumeAt = onboardingStep(user);
  if (resumeAt) return <Onboarding initial={resumeAt} />;

  // Wait for the role before choosing a shell, so an employee never sees the
  // admin sidebar flash past on the way to their portal.
  if (activeOrg?.id && myRole === undefined) {
    return (
      <div className="app-loading">
        <div style={{ textAlign: 'center' }}>
          <div className="app-loading-spinner" />
          <span className="app-loading-text">Loading StartupBuddy…</span>
        </div>
      </div>
    );
  }

  if (myRole === 'employee') return <EmployeePortal />;

  // Old paths go to their new screens — which is also how the agent's
  // navigation (whose hrefs are the old paths) lands in the right place.
  const moved = resolveLegacyPath(location.pathname + location.search + location.hash);
  if (moved) return <Navigate to={moved} replace />;

  const meta = activePage === 'new-quotation' && editingDocId
    ? { title: 'Edit Quotation', subtitle: `Revising ${docNumber(documentStore.getById(editingDocId)) || 'quotation'}` }
    : (PAGE_META[activePage] || PAGE_META.dashboard);

  // Pages still on their old route keep their old frame's styling, embedded
  // in the new shell, with a strip of the pages of the section they belong to
  // (or of their old module, for the few that belong to no section).
  const section = sectionOf(location.pathname);
  const onProfile = activePage === 'profile';
  const framed = (!!activeModule || onProfile || !!(section && LEGACY_PAGES[section]?.includes(activePage)))
    && section !== 'chat';
  const sectionPages = section ? LEGACY_PAGES[section] || [] : [];
  const moduleItems = section && section !== 'settings'
    ? NAV_ITEMS.filter((i) => i.id && sectionPages.includes(i.id))
    : activeModule ? NAV_ITEMS.filter((i) => i.id && MODULE_FILTER[activeModule]?.includes(i.id)) : [];
  const flush = FLUSH_PAGES.has(activePage) || /^\/recurring\/(new|edit)/.test(location.pathname);
  // The document editors keep their own full-page form; no composer under them.
  const editor = /^\/money\/invoices\/(new|[^/]+\/edit)\/?$/.test(location.pathname) || /^\/team\/letters\//.test(location.pathname);

  return (
    <AssistantProvider orgId={activeOrg?.id || null} userId={user?.id || null} assistantName={persona.name} personaId={persona.id}>
      <ShellProvider>
      <AppShell composer={!flush && !editor}>
        <ShellFrame
          on={framed}
          theme="light" user={user}
          module={onProfile ? { label: 'Settings' } : MODULE_META[activeModule]}
          items={moduleItems}
          title={meta.title} subtitle={meta.subtitle}
          flush={flush}
          onLogout={logout}
        >
          <Routes>
            <Route index element={<Navigate to="/home" replace />} />
            <Route path="home" element={<HomeScreen />} />
            <Route path="chat" element={<ChatScreen />} />
            <Route path="business" element={<BusinessScreen />} />
            <Route path="money" element={<Navigate to="/money/transactions" replace />} />
            <Route path="money/invoices/new" element={<DocEditor />} />
            <Route path="money/invoices/:docId/edit" element={<DocEditor />} />
            <Route path="money/:tab" element={<MoneyScreen />} />
            <Route path="clients" element={<ClientsScreen />} />
            <Route path="work" element={<WorkScreen />} />
            <Route path="team" element={<TeamScreen />} />
            <Route path="team/letters/:kind/new" element={<LetterEditor />} />
            <Route path="settings" element={<SettingsScreen />} />
            <Route path="dashboard" element={<Overview />} />
            <Route path="dashboard/finance" element={<FinanceDash />} />
            <Route path="dashboard/sales" element={<SalesDash />} />
            <Route path="dashboard/team" element={<TeamDash />} />
            <Route path="dashboard/projects" element={<ProjectsDash />} />
            <Route path="dashboard/documents" element={<DocumentsDash />} />
            <Route path="dashboard/usage" element={<UsageDash />} />
            <Route path="edgebrain" element={<EdgeBrain />} />
            <Route path="profile" element={<CompanyProfile />} />
            <Route path="offers" element={<OfferForm />} />
            <Route path="new-certificates" element={<CertificateForm />} />
            <Route path="certificates" element={<CertificateForm />} />
            <Route path="ndas" element={<NdaForm />} />
            <Route path="mous" element={<MoUForm />} />
            <Route path="finance-status" element={<FinanceStatus />} />
            <Route path="cashbook" element={<CashBook />} />
            <Route path="invoices" element={<InvoiceList type="invoice" />} />
            <Route path="quotations" element={<InvoiceList type="quotation" />} />
            <Route path="proforma" element={<InvoiceList type="proforma" />} />
            <Route path="recurring" element={<RecurringInvoiceList />} />
            <Route path="vendors" element={<Vendors />} />
            <Route path="purchases" element={<PurchaseInvoices />} />
            <Route path="tax-summary" element={<TaxSummary />} />
            <Route path="profit-loss" element={<ProfitLoss />} />
            <Route path="recurring/new" element={<RecurringInvoiceForm />} />
            <Route path="recurring/edit/:id" element={<RecurringInvoiceFormWrapper />} />
            <Route path="new-invoice" element={<InvoiceForm />} />
            <Route path="new-quotation" element={<QuotationForm editDocId={null} />} />
            <Route path="new-quotation/:docId" element={<QuotationFormWrapper />} />
            <Route path="new-proforma" element={<ProformaInvoiceForm />} />
            <Route path="crm" element={<CRM />} />
            <Route path="customers" element={<Customers />} />
            <Route path="products" element={<Products />} />
            <Route path="revenue" element={<BillingRevenue />} />
            <Route path="planner" element={<ProductPlanner />} />
            <Route path="records" element={<InternRecords />} />
            <Route path="library" element={<DocumentLibrary />} />
            <Route path="employees" element={<Employees />} />
            <Route path="employees/new" element={<EmployeeForm />} />
            <Route path="ex-employees" element={<ExEmployees />} />
            <Route path="me" element={<EmployeePortal />} />
            <Route path="attendance" element={<AttendanceSheet />} />
            <Route path="leave" element={<LeaveRequests />} />
            <Route path="announcements" element={<Announcements />} />
            <Route path="team-hierarchy" element={<TeamHierarchy />} />
            <Route path="offer-tracker" element={<OfferTracker onNavigate={routerNavigate} />} />
            <Route path="tasks" element={<TasksPage />} />
            <Route path="projects" element={<ProjectsPage />} />
            <Route path="projects/new" element={<ProjectForm />} />
            <Route path="projects/:projectId" element={<ProjectDetail />} />
            <Route path="portfolio" element={<Portfolio />} />
            <Route path="timesheets" element={<Timesheets />} />
            <Route path="bulk-offers" element={<BulkOfferLetters />} />
            <Route path="bulk-certificates" element={<BulkCertificates />} />
            <Route path="bulk-team" element={<BulkTeamMembers />} />
            <Route path="bulk-history" element={<BulkHistory />} />
            <Route path="*" element={<Navigate to="/home" replace />} />
          </Routes>
        </ShellFrame>
      </AppShell>
      </ShellProvider>
    </AssistantProvider>
  );
}


// Wraps a page that has not moved yet in its old frame, embedded. New
// screens pass straight through.
function ShellFrame({ on, children, ...props }) {
  if (!on) return children;
  return <div className="sb-legacy"><ModuleShell embedded {...props}>{children}</ModuleShell></div>;
}

// Invoice, quotation and proforma editors: their existing form-beside-preview
// pages, full screen, restyled onto the StartupBuddy tokens (docEditor.css)
// under a StartupBuddy top bar (the A4 preview is the document).
function DocEditor() {
  const { docId } = useParams();
  const [params] = useSearchParams();
  // Editing: quotations (drafts and revisions) and proforma drafts, which say
  // so with ?type=proforma. Invoices are never edited: a draft invoice lives on
  // the device until it is created (InvoiceForm).
  const type = params.get('type') || (docId ? 'quotation' : 'invoice');
  const title = docId
    ? (type === 'proforma' ? 'Edit proforma' : 'Edit quotation')
    : { invoice: 'New invoice', quotation: 'New quotation', proforma: 'New proforma invoice' }[type] || 'New document';
  const form = type === 'proforma' ? <ProformaInvoiceForm key={docId || 'new'} editDocId={docId || null} />
    : type === 'quotation' ? <QuotationForm key={docId || 'new'} editDocId={docId || null} />
      : <InvoiceForm />;
  return (
    <EditorFrame title={title} sub="Saved documents appear in Money" back={`/money/invoices${docId ? '' : `?type=${type}`}`} backLabel="Money">
      {form}
    </EditorFrame>
  );
}

// Offer letters and NDAs: their existing form-and-preview editors.
function LetterEditor() {
  const { kind } = useParams();
  const form = kind === 'nda' ? <NdaForm /> : <OfferForm />;
  return (
    <EditorFrame title={kind === 'nda' ? 'New NDA' : 'New offer letter'} sub="Saved letters appear on Team" back="/team" backLabel="Team">
      {form}
    </EditorFrame>
  );
}

// The old frame keeps the forms' plumbing (their CSS variables, the bridge);
// the bar above it is the new one.
function EditorFrame({ title, sub, back, backLabel, children }) {
  const navigate = useNavigate();
  return (
    <div className="sb-legacy sb-doced">
      <header className="sb-top sb-doced-top">
        <button type="button" className="sb-btn ghost icon" onClick={() => navigate(back)} aria-label={`Back to ${backLabel}`}>
          <IconChevronLeft />
        </button>
        <div className="tt"><b>{title}</b><small>{sub}</small></div>
      </header>
      <ModuleShell embedded bare theme="light" title={title} items={[]} flush>{children}</ModuleShell>
    </div>
  );
}

function QuotationFormWrapper() {
  const { docId } = useParams();
  return <QuotationForm editDocId={docId} />;
}

function RecurringInvoiceFormWrapper() {
  const { id } = useParams();
  const [item, setItem] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const items = documentStore.getRecurring();
    const found = items.find(i => i.id === id);
    setItem(found);
    setLoading(false);
  }, [id]);

  if (loading) return <div role="status" style={{ padding: 24, fontSize: 11.5 }}>Loading…</div>;
  if (!item) return <div role="alert" style={{ padding: 24, fontSize: 11.5 }}>Recurring invoice not found.</div>;
  return <RecurringInvoiceForm editItem={item} />;
}

function PortalRouteWrapper() {
  const { documentId } = useParams();
  return (
    <ToastProvider>
      <div className="sb-portal"><RecipientPortal documentId={documentId} /></div>
    </ToastProvider>
  );
}

function App() {
  return (
    <AuthProvider>
      <OrgProvider>
        <ToastProvider>
          <Routes>
            <Route path="/portal/:documentId" element={<PortalRouteWrapper />} />
            {/* Outside AppContent: whoever lands here has no membership yet,
                and the shell would read that as "needs to create a company". */}
            <Route path="/join" element={<JoinPortal />} />
            {/* The platform console. Outside AppContent because it is scoped to
                every tenant rather than one, and it gates on its own operator
                sign-in rather than the workspace session. */}
            <Route path="/admin/*" element={<AdminApp />} />
            {Object.keys(subPages).map(path => {
              const SubPageComponent = subPages[path];
              return (
                <Route key={path} path={path} element={<SubPage><SubPageComponent /></SubPage>} />
              );
            })}
            <Route path="/*" element={<AppContent />} />
          </Routes>
          {/* Every delete in the app confirms through this one dialog. */}
          <ConfirmHost />
        </ToastProvider>
      </OrgProvider>
    </AuthProvider>
  );
}

export default App;
