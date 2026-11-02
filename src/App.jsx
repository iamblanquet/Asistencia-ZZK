import { useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  CalendarDays,
  Clock,
  Edit,
  FileDown,
  Lock,
  RefreshCw,
  Search,
  User,
  Users,
  Wifi,
  WifiOff,
  LayoutDashboard,
  BarChart3,
  Moon,
  Sun,
  Menu,
  Settings,
  Plus,
  Trash2
} from 'lucide-react';
import {
  AsistoIcon,
  AsistoLogo,
  IconPersonal,
  IconAsistencia,
  IconEntradasSalidas,
  IconReportes,
  IconIncidencias,
  IconConfiguracion,
  LoginWaveDecoration,
} from './components/BrandAssets';
import { jsPDF } from 'jspdf';
import autoTable from 'jspdf-autotable';
import {
  LineChart,
  Line,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip as RechartsTooltip,
  ResponsiveContainer,
  PieChart,
  Pie,
  Cell
} from 'recharts';

import {
  addDays,
  buildDailySummary,
  buildEmployeeTotals,
  dateLabel,
  dateTimeLabel,
  decimalHours,
  durationLabel,
  timeLabel,
  todayInputValue,
} from './utils/attendance';

const defaultTo = todayInputValue();
const defaultFrom = addDays(defaultTo, -14);

const initialSchedule = {
  shiftStart: '08:00',
  shiftEnd: '17:00',
  satShiftStart: '08:00',
  satShiftEnd: '13:00',
  graceMinutes: 10,
};

function getInitials(name) {
  const parts = String(name || '').trim().split(/\s+/);
  if (parts.length === 0 || !parts[0]) return '?';
  if (parts.length === 1) return parts[0].substring(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

const avatarColors = [
  'linear-gradient(135deg, #FF7A00, #d96600)', // Naranja ITZ
  'linear-gradient(135deg, #1B1F24, #374151)', // Grafito
  'linear-gradient(135deg, #6B7280, #4b5563)', // Gris Medio
  'linear-gradient(135deg, #10b981, #047857)', // Esmeralda
  'linear-gradient(135deg, #f59e0b, #b45309)', // Ámbar
  'linear-gradient(135deg, #06b6d4, #0891b2)', // Cian
];

function getAvatarBackground(employeeId) {
  const cleanId = String(employeeId || '');
  const charSum = cleanId.split('').reduce((acc, char) => acc + char.charCodeAt(0), 0);
  const index = Math.abs(charSum) % avatarColors.length;
  return avatarColors[index];
}

function App() {
  const latestLoad = useRef(0);
  const loadedDeviceId = useRef('');

  const [currentUser, setCurrentUser] = useState(() => {
    if (typeof window === 'undefined') return null;
    const stored = window.localStorage.getItem('zkteco-user');
    return stored ? JSON.parse(stored) : null;
  });

  const [loginUsername, setLoginUsername] = useState('');
  const [loginPassword, setLoginPassword] = useState('');
  const [loginError, setLoginError] = useState('');
  const [loggingIn, setLoggingIn] = useState(false);

  // States for user administration
  const [portalUsers, setPortalUsers] = useState([]);
  const [selectedUserEdit, setSelectedUserEdit] = useState(null);
  const [userFormUsername, setUserFormUsername] = useState('');
  const [userFormPassword, setUserFormPassword] = useState('');
  const [userFormRole, setUserFormRole] = useState('user');
  const [userFormDevices, setUserFormDevices] = useState([]);
  const [loadingUsers, setLoadingUsers] = useState(false);

  const [theme, setTheme] = useState(() => {
    if (typeof window === 'undefined') return 'light';
    return window.localStorage.getItem('zkteco-theme')
      || (window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  });
  const [sidebarCollapsed, setSidebarCollapsed] = useState(true);
  const [activeTab, setActiveTab] = useState('general');
  const [isConfigOpen, setIsConfigOpen] = useState(false);
  const [range, setRange] = useState({ from: defaultFrom, to: defaultTo });
  const [schedule, setSchedule] = useState(initialSchedule);
  const [employees, setEmployees] = useState([]);
  const [events, setEvents] = useState([]);
  const [selectedEmployee, setSelectedEmployee] = useState('all');
  const [employeeQuery, setEmployeeQuery] = useState('');
  const [device, setDevice] = useState({ ip: '172.28.10.105', port: 4370 });
  const [deviceInfo, setDeviceInfo] = useState(null);
  const [fetchedAt, setFetchedAt] = useState(null);
  const [loading, setLoading] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [error, setError] = useState('');

  // Nuevos estados para administración de múltiples biométricos
  const [devices, setDevices] = useState([]);
  const [activeDeviceId, setActiveDeviceId] = useState('');
  const [selectedEditDeviceId, setSelectedEditDeviceId] = useState('');
  const [editName, setEditName] = useState('');
  const [editIp, setEditIp] = useState('');
  const [editPort, setEditPort] = useState(4370);
  const [editModel, setEditModel] = useState('WL20/EWL20');
  const [editProtocol, setEditProtocol] = useState('zk');
  const [editShiftStart, setEditShiftStart] = useState('08:00');
  const [editShiftEnd, setEditShiftEnd] = useState('17:00');
  const [editSatShiftStart, setEditSatShiftStart] = useState('08:00');
  const [editSatShiftEnd, setEditSatShiftEnd] = useState('13:00');
  const [editGraceMinutes, setEditGraceMinutes] = useState(10);
  const [testingConnection, setTestingConnection] = useState(false);
  const [testResult, setTestResult] = useState(null);
  const [savingConfig, setSavingConfig] = useState(false);

  // Estados para renombrar colaboradores en la plataforma y paginación
  const [editingEmployeeId, setEditingEmployeeId] = useState('');
  const [editingEmployeeName, setEditingEmployeeName] = useState('');
  const [employeesPage, setEmployeesPage] = useState(1);

  async function handleLogin(e) {
    e.preventDefault();
    setLoginError('');
    setLoggingIn(true);
    try {
      const response = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: loginUsername, password: loginPassword })
      });
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.message || 'Error de inicio de sesión.');
      }
      
      window.localStorage.setItem('zkteco-token', data.token);
      window.localStorage.setItem('zkteco-user', JSON.stringify(data.user));
      
      setCurrentUser(data.user);
      
      // Load devices and events after login
      const list = await loadDevices();
      const firstDev = list?.[0];
      if (firstDev) {
        setActiveDeviceId(firstDev.id);
        loadEvents(range, firstDev.id);
      } else {
        loadEvents(range);
      }
    } catch (err) {
      setLoginError(err.message || 'Usuario o contraseña incorrectos.');
    } finally {
      setLoggingIn(false);
    }
  }

  async function handleLogout() {
    try {
      const token = window.localStorage.getItem('zkteco-token');
      if (token) {
        await fetch('/api/auth/logout', {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${token}` }
        }).catch(() => {});
      }
    } finally {
      window.localStorage.removeItem('zkteco-token');
      window.localStorage.removeItem('zkteco-user');
      setCurrentUser(null);
    }
  }

  async function loadPortalUsers() {
    if (currentUser?.role !== 'admin') return;
    setLoadingUsers(true);
    try {
      const list = await getJson('/api/admin/users');
      setPortalUsers(list || []);
    } catch (e) {
      console.error('Error al cargar usuarios:', e);
    } finally {
      setLoadingUsers(false);
    }
  }

  useEffect(() => {
    if (activeTab === 'usuarios') {
      loadPortalUsers();
    }
  }, [activeTab]);

  async function handleSaveUser(e) {
    e.preventDefault();
    const payload = {
      username: userFormUsername,
      role: userFormRole,
      assignedDevices: userFormDevices
    };
    if (userFormPassword) {
      payload.password = userFormPassword;
    }
    
    try {
      if (selectedUserEdit === 'new') {
        await apiRequest('/api/admin/users', {
          method: 'POST',
          body: JSON.stringify(payload)
        });
      } else {
        await apiRequest(`/api/admin/users/${selectedUserEdit}`, {
          method: 'PUT',
          body: JSON.stringify(payload)
        });
      }
      
      setUserFormUsername('');
      setUserFormPassword('');
      setUserFormRole('user');
      setUserFormDevices([]);
      setSelectedUserEdit(null);
      await loadPortalUsers();
      alert('Usuario guardado con éxito.');
    } catch (err) {
      alert(err.message || 'Error al guardar el usuario.');
    }
  }

  async function handleDeleteUser(userId) {
    if (!window.confirm('¿Está seguro de que desea eliminar este usuario?')) return;
    try {
      await apiRequest(`/api/admin/users/${userId}`, { method: 'DELETE' });
      await loadPortalUsers();
      alert('Usuario eliminado.');
    } catch (err) {
      alert(err.message || 'Error al eliminar el usuario.');
    }
  }

  function startCreateUser() {
    setSelectedUserEdit('new');
    setUserFormUsername('');
    setUserFormPassword('');
    setUserFormRole('user');
    setUserFormDevices([]);
  }

  function startEditUser(u) {
    setSelectedUserEdit(u.id);
    setUserFormUsername(u.username);
    setUserFormPassword('');
    setUserFormRole(u.role);
    setUserFormDevices(u.assignedDevices || []);
  }

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    document.documentElement.style.colorScheme = theme;
    window.localStorage.setItem('zkteco-theme', theme);
  }, [theme]);

  useEffect(() => {
    if (!currentUser) return;
    loadDevices().then((list) => {
      const firstDev = list?.[0];
      if (firstDev) {
        setActiveDeviceId(firstDev.id);
        loadEvents(range, firstDev.id);
      } else {
        loadEvents(range);
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentUser]);

  const visibleEvents = useMemo(() => {
    const query = employeeQuery.trim().toLowerCase();

    return events.filter((event) => {
      const matchesEmployee =
        selectedEmployee === 'all' || String(event.employeeId) === selectedEmployee;
      const searchable = `${event.employeeId} ${event.employeeName}`.toLowerCase();
      const matchesQuery = !query || searchable.includes(query);
      return matchesEmployee && matchesQuery;
    });
  }, [employeeQuery, events, selectedEmployee]);

  const enrichedEvents = useMemo(() => {
    const groups = {};
    for (const event of events) {
      const dateKey = event.localDate || event.timestamp.split('T')[0];
      const key = `${event.employeeId}::${dateKey}`;
      if (!groups[key]) {
        groups[key] = [];
      }
      groups[key].push(event);
    }

    for (const key in groups) {
      groups[key].sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
    }

    return visibleEvents.map((event) => {
      const dateKey = event.localDate || event.timestamp.split('T')[0];
      const key = `${event.employeeId}::${dateKey}`;
      const dayEvents = groups[key] || [];

      let type = 'Marcación';
      if (dayEvents.length > 0) {
        if (event.id === dayEvents[0].id) {
          type = 'Entrada';
        } else if (dayEvents.length > 1 && event.id === dayEvents[dayEvents.length - 1].id) {
          const date = new Date(event.timestamp);
          const isSaturday = date.getDay() === 6;
          const shiftEnd = isSaturday ? (schedule.satShiftEnd || '13:00') : schedule.shiftEnd;
          
          const [endHours, endMinutes] = shiftEnd.split(':').map(Number);
          const eventHours = date.getHours();
          const eventMinutes = date.getMinutes();
          
          const eventTimeInMinutes = eventHours * 60 + eventMinutes;
          const shiftEndTimeInMinutes = endHours * 60 + endMinutes;
          
          if (eventTimeInMinutes < shiftEndTimeInMinutes) {
            type = 'Salida Temprana';
          } else {
            type = 'Salida';
          }
        }
      }

      return {
        ...event,
        eventType: type,
      };
    });
  }, [events, visibleEvents, schedule]);

  const summaryRows = useMemo(
    () => buildDailySummary(visibleEvents, employees, schedule),
    [employees, schedule, visibleEvents],
  );

  const totals = useMemo(() => buildEmployeeTotals(summaryRows), [summaryRows]);

  const filteredEmployees = useMemo(() => {
    return employees.filter(emp => {
      const q = employeeQuery.toLowerCase().trim();
      if (!q) return true;
      return String(emp.employeeId).toLowerCase().includes(q) || String(emp.name).toLowerCase().includes(q);
    });
  }, [employees, employeeQuery]);

  const employeeItemsPerPage = 25;
  const totalEmployeePages = Math.ceil(filteredEmployees.length / employeeItemsPerPage) || 1;

  useEffect(() => {
    if (employeesPage > totalEmployeePages) {
      setEmployeesPage(totalEmployeePages);
    }
  }, [filteredEmployees.length, totalEmployeePages, employeesPage]);

  const paginatedEmployees = useMemo(() => {
    const startIndex = (employeesPage - 1) * employeeItemsPerPage;
    return filteredEmployees.slice(startIndex, startIndex + employeeItemsPerPage);
  }, [filteredEmployees, employeesPage]);

  const totalWorked = totals.reduce((sum, row) => sum + row.workedMinutes, 0);
  const totalOvertime = totals.reduce((sum, row) => sum + row.overtimeMinutes, 0);
  const totalLates = totals.reduce((sum, row) => sum + row.lateCount, 0);

  // Chart Data
  const dailyWorkData = useMemo(() => {
    const map = new Map();

    summaryRows.forEach((row) => {
      const current = map.get(row.dateKey) || {
        dateKey: row.dateKey,
        date: dateLabel(row.dateKey),
        workedMinutes: 0,
        scheduledMinutes: 0,
        lateCount: 0,
      };

      current.workedMinutes += row.workedMinutes;
      current.scheduledMinutes += row.scheduledMinutes;
      current.lateCount += row.isLate ? 1 : 0;
      map.set(row.dateKey, current);
    });

    return Array.from(map.values())
      .map((item) => ({
        dateKey: item.dateKey,
        date: item.date,
        workedHours: decimalHours(item.workedMinutes),
        scheduledHours: decimalHours(item.scheduledMinutes),
        compliance: item.scheduledMinutes > 0
          ? Math.round((item.workedMinutes / item.scheduledMinutes) * 100)
          : 0,
        lates: item.lateCount,
      }))
      .sort((a, b) => a.dateKey.localeCompare(b.dateKey));
  }, [summaryRows]);

  const topIssueEmployees = useMemo(() => {
    return [...totals]
      .filter((row) => row.lateCount || row.earlyLeaveCount || row.incompleteDays)
      .sort((a, b) => (b.lateCount + b.earlyLeaveCount + b.incompleteDays) - (a.lateCount + a.earlyLeaveCount + a.incompleteDays))
      .slice(0, 6);
  }, [totals]);

  const topPunctualEmployees = useMemo(() => {
    const empData = {};
    summaryRows.forEach((row) => {
      if (!row.firstPunch) return;
      const dateObj = new Date(row.firstPunch);
      const minutes = dateObj.getHours() * 60 + dateObj.getMinutes();
      
      if (!empData[row.employeeId]) {
        empData[row.employeeId] = {
          employeeId: row.employeeId,
          employeeName: row.employeeName,
          minutesSum: 0,
          count: 0,
        };
      }
      empData[row.employeeId].minutesSum += minutes;
      empData[row.employeeId].count += 1;
    });

    return Object.values(empData)
      .map((emp) => {
        const avgMinutes = emp.minutesSum / emp.count;
        const avgHours = Math.floor(avgMinutes / 60);
        const avgMins = Math.round(avgMinutes % 60);
        const formattedTime = `${String(avgHours).padStart(2, '0')}:${String(avgMins).padStart(2, '0')}`;
        return {
          ...emp,
          avgMinutes,
          formattedTime,
        };
      })
      .sort((a, b) => a.avgMinutes - b.avgMinutes)
      .slice(0, 5);
  }, [summaryRows]);

  const distributionData = useMemo(() => {
    let ok = 0, late = 0, early = 0, open = 0, both = 0;
    summaryRows.forEach(row => {
       if (row.isIncomplete) open++;
       else if (row.isEarlyLeave && row.isLate) both++;
       else if (row.isLate) late++;
       else if (row.isEarlyLeave) early++;
       else ok++;
    });
    const total = ok + late + early + open + both || 1;
    const getPercent = (v) => Math.round((v / total) * 100);
    return [
      { name: 'A tiempo', value: ok, percentage: getPercent(ok), color: '#10b981' },
      { name: 'Retardo', value: late, percentage: getPercent(late), color: '#FF7A00' },
      { name: 'S. Temprana', value: early, percentage: getPercent(early), color: '#6B7280' },
      { name: 'Incompleto', value: open, percentage: getPercent(open), color: '#f59e0b' },
      { name: 'Retardo + S. temprana', value: both, percentage: getPercent(both), color: '#ef4444' },
    ].filter(d => d.value > 0);
  }, [summaryRows]);

  const chartTheme = useMemo(() => ({
    axis: theme === 'dark' ? '#9ca3af' : '#6B7280',
    grid: theme === 'dark' ? '#2a3038' : '#E5E7EB',
    tooltipBg: theme === 'dark' ? '#1B1F24' : '#ffffff',
    tooltipBorder: theme === 'dark' ? '#374151' : '#E5E7EB',
    tooltipText: theme === 'dark' ? '#f9fafb' : '#1B1F24',
    workedLine: '#FF7A00',
    plannedLine: theme === 'dark' ? '#9ca3af' : '#1B1F24',
    lateBar: '#FF7A00',
    earlyBar: '#6B7280',
  }), [theme]);

  async function loadDevices() {
    try {
      const list = await getJson('/api/devices');
      setDevices(list || []);
      return list;
    } catch (e) {
      console.error("Error al cargar dispositivos:", e);
      return [];
    }
  }

  async function loadEvents(customRange = range, deviceId = activeDeviceId) {
    const requestId = ++latestLoad.current;
    if (deviceId !== loadedDeviceId.current) {
      loadedDeviceId.current = deviceId;
      setEmployees([]);
      setEvents([]);
      setDeviceInfo(null);
      setFetchedAt(null);
      setSelectedEmployee('all');
      setEmployeeQuery('');
      setEditingEmployeeId('');
      setEmployeesPage(1);
    }
    setLoading(true);
    setError('');

    try {
      const params = new URLSearchParams({
        from: customRange.from,
        to: customRange.to,
      });
      if (deviceId) {
        params.set('deviceId', deviceId);
      }
      const payload = await getJson(`/api/events?${params.toString()}`);
      if (requestId !== latestLoad.current) return;
      if (deviceId && payload.device?.id !== deviceId) throw new Error('La respuesta no corresponde al biometrico seleccionado.');
      setEmployees(payload.employees || []);
      setEvents(payload.events || []);
      if (payload.device) {
        setDevice(payload.device);
        setActiveDeviceId(payload.device.id);
        setSchedule({
          shiftStart: payload.device.shiftStart || '08:00',
          shiftEnd: payload.device.shiftEnd || '17:00',
          satShiftStart: payload.device.satShiftStart || '08:00',
          satShiftEnd: payload.device.satShiftEnd || '13:00',
          graceMinutes: payload.device.graceMinutes !== undefined ? payload.device.graceMinutes : 10,
        });
      }
      setDeviceInfo(payload.deviceInfo || null);
      setFetchedAt(payload.fetchedAt || null);
    } catch (requestError) {
      if (requestId !== latestLoad.current) return;
      setEmployees([]);
      setEvents([]);
      setDevice(requestError.device || device);
      setError(requestError.message);
    } finally {
      if (requestId === latestLoad.current) setLoading(false);
    }
  }

  function openConfigModal() {
    const list = devices.length > 0 ? devices : [device];
    const dev = list.find(d => d.id === activeDeviceId) || list[0] || device;
    setSelectedEditDeviceId(dev.id || 'dev-default');
    setEditName(dev.name || 'ZKTeco');
    setEditIp(dev.ip || '172.28.10.105');
    setEditPort(dev.port || 4370);
    setEditModel(dev.model || 'WL20/EWL20');
    setEditProtocol(dev.protocol || 'zk');
    setEditShiftStart(dev.shiftStart || '08:00');
    setEditShiftEnd(dev.shiftEnd || '17:00');
    setEditSatShiftStart(dev.satShiftStart || '08:00');
    setEditSatShiftEnd(dev.satShiftEnd || '13:00');
    setEditGraceMinutes(dev.graceMinutes !== undefined ? dev.graceMinutes : 10);
    setTestResult(null);
    setTestingConnection(false);
    setIsConfigOpen(true);
  }

  function selectDeviceForEdit(dev) {
    setSelectedEditDeviceId(dev.id);
    setEditName(dev.name || 'ZKTeco');
    setEditIp(dev.ip || '127.0.0.1');
    setEditPort(dev.port || 4370);
    setEditModel(dev.model || 'WL20/EWL20');
    setEditProtocol(dev.protocol || 'zk');
    setEditShiftStart(dev.shiftStart || '08:00');
    setEditShiftEnd(dev.shiftEnd || '17:00');
    setEditSatShiftStart(dev.satShiftStart || '08:00');
    setEditSatShiftEnd(dev.satShiftEnd || '13:00');
    setEditGraceMinutes(dev.graceMinutes !== undefined ? dev.graceMinutes : 10);
    setTestResult(null);
    setTestingConnection(false);
  }

  function addNewDeviceForEdit() {
    setSelectedEditDeviceId('new');
    setEditName('Nuevo Biométrico');
    setEditIp('192.168.1.100');
    setEditPort(4370);
    setEditModel('WL20/EWL20');
    setEditProtocol('zk');
    setEditShiftStart('08:00');
    setEditShiftEnd('17:00');
    setEditSatShiftStart('08:00');
    setEditSatShiftEnd('13:00');
    setEditGraceMinutes(10);
    setTestResult(null);
    setTestingConnection(false);
  }

  async function handleTestConnection() {
    setTestingConnection(true);
    setTestResult(null);
    try {
      const params = new URLSearchParams({
        deviceId: selectedEditDeviceId !== 'new' ? selectedEditDeviceId : '',
        ip: editIp,
        port: String(editPort)
      });
      const data = await apiRequest(`/api/device/diagnostics?${params.toString()}`);
      
      setTestResult({
        ok: true,
        message: `Conectado: ${data.deviceName || data.device?.model || 'ZKTeco'}. Firmware: ${data.firmware || 'N/D'}. SN: ${data.serialNumber || 'N/D'}`
      });
    } catch (e) {
      setTestResult({
        ok: false,
        message: e.message || 'Error al conectar con el biométrico.'
      });
    } finally {
      setTestingConnection(false);
    }
  }

  async function handleSaveConfig() {
    setSavingConfig(true);
    try {
      const payload = {
        name: editName,
        ip: editIp,
        port: Number(editPort),
        model: editModel,
        protocol: editProtocol,
        shiftStart: editShiftStart,
        shiftEnd: editShiftEnd,
        satShiftStart: editSatShiftStart,
        satShiftEnd: editSatShiftEnd,
        graceMinutes: Number(editGraceMinutes)
      };
      
      const savedDevice = await apiRequest(
        selectedEditDeviceId === 'new' ? '/api/devices' : `/api/devices/${selectedEditDeviceId}`,
        {
          method: selectedEditDeviceId === 'new' ? 'POST' : 'PUT',
          body: JSON.stringify(payload)
        }
      );
      
      const updatedList = await loadDevices();
      const nextActiveId = savedDevice?.id || selectedEditDeviceId;
      setActiveDeviceId(nextActiveId);
      await loadEvents(range, nextActiveId);
      setIsConfigOpen(false);
    } catch (e) {
      alert(e.message || 'Error al guardar la configuración.');
    } finally {
      setSavingConfig(false);
    }
  }

  async function handleDeleteDevice(id, e) {
    if (e) e.stopPropagation();
    if (!window.confirm('¿Está seguro de que desea eliminar este biométrico?')) return;
    
    try {
      await apiRequest(`/api/devices/${id}`, {
        method: 'DELETE'
      });
      
      const updatedList = await loadDevices();
      
      if (activeDeviceId === id) {
        const firstDev = updatedList?.[0];
        if (firstDev) {
          setActiveDeviceId(firstDev.id);
          loadEvents(range, firstDev.id);
        } else {
          setActiveDeviceId('');
          setDevice({ ip: '', port: 4370 });
          setEmployees([]);
          setEvents([]);
        }
      }
      
      if (selectedEditDeviceId === id) {
        const firstDev = updatedList?.[0];
        if (firstDev) {
          selectDeviceForEdit(firstDev);
        } else {
          addNewDeviceForEdit();
        }
      }
    } catch (e) {
      alert(e.message || 'Error al eliminar el dispositivo.');
    }
  }

  async function handleSaveEmployeeName(employeeId) {
    const deviceId = activeDeviceId;
    const targetName = editingEmployeeName.trim();
    if (!targetName) return;

    try {
      if (!deviceId) throw new Error('Seleccione el biometrico.');
      await apiRequest(`/api/employees/${encodeURIComponent(employeeId)}?deviceId=${encodeURIComponent(deviceId)}`, {
        method: 'PUT',
        body: JSON.stringify({ name: targetName })
      });
      
      if (loadedDeviceId.current !== deviceId) return;
      // Update local state instantly
      setEmployees(current => current.map(emp => 
        String(emp.employeeId) === String(employeeId) 
          ? { ...emp, name: targetName } 
          : emp
      ));
      
      setEvents(current => current.map(evt => 
        String(evt.employeeId) === String(employeeId) 
          ? { ...evt, employeeName: targetName } 
          : evt
      ));

      setEditingEmployeeId('');
      await loadEvents();
    } catch (e) {
      alert(e.message || 'Error al guardar el nombre.');
    }
  }

  function downloadEmployeeList() {
    const doc = new jsPDF({ orientation: 'portrait', unit: 'pt', format: 'letter' });
    
    // Top bar Grafito + Naranja ITZ
    doc.setFillColor(27, 31, 36);
    doc.rect(0, 0, 612, 6, 'F');
    doc.setFillColor(255, 122, 0);
    doc.rect(0, 6, 612, 3, 'F');

    drawAsistoPdfBrand(doc, 40, 22);

    doc.setFont('helvetica', 'bold');
    doc.setFontSize(14);
    doc.setTextColor(27, 31, 36);
    doc.text('DIRECTORIO DE COLABORADORES', 165, 34);

    doc.setFont('helvetica', 'normal');
    doc.setFontSize(9);
    doc.setTextColor(107, 114, 128);
    const dateStr = new Date().toLocaleString('es-MX');
    doc.text(`Dispositivo: ${device.name || 'ZKTeco'} (${device.ip})`, 165, 48);
    doc.text(`Fecha de exportación: ${dateStr}`, 165, 60);

    doc.setDrawColor(229, 231, 235);
    doc.line(40, 74, 572, 74);

    const headers = ['ID', 'Nombre Completo', 'Rol', 'No. Tarjeta'];
    const body = employees.map((emp) => [
      emp.employeeId,
      emp.name,
      emp.role === 14 ? 'Administrador' : 'Usuario Normal',
      emp.cardNo || '-',
    ]);

    autoTable(doc, {
      startY: 90,
      head: [headers],
      body: body,
      styles: { font: 'helvetica', fontSize: 9, cellPadding: 6, textColor: [27, 31, 36] },
      headStyles: { fillColor: [27, 31, 36], textColor: 255 },
      alternateRowStyles: { fillColor: [248, 249, 250] },
      margin: { left: 40, right: 40 },
    });

    const pageCount = doc.internal.getNumberOfPages();
    for (let i = 1; i <= pageCount; i++) {
      doc.setPage(i);
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(8);
      doc.setTextColor(107, 114, 128);
      doc.text(`ASISTO By ITZ | OIL & GAS  —  Pág. ${i} de ${pageCount}`, 306, 765, { align: 'center' });
    }

    doc.save(`directorio-colaboradores-${(device.name || 'biometrico').replace(/\s+/g, '_')}.pdf`);
  }

  async function downloadReport(mode = 'consolidated') {
    setDownloading(true);
    setError('');

    const reportTo = range.to || todayInputValue();
    const reportFrom = range.from || addDays(reportTo, -14);

    try {
      if (!activeDeviceId) throw new Error('Seleccione el biometrico.');
      const params = new URLSearchParams({
        from: reportFrom,
        to: reportTo,
        deviceId: activeDeviceId,
      });

      if (selectedEmployee !== 'all') {
        params.set('employeeId', selectedEmployee);
      }

      const payload = await getJson(`/api/events?${params.toString()}`);
      const reportEmployees = payload.employees || employees;
      const reportRows = buildDailySummary(payload.events || [], reportEmployees, schedule);
      const reportTotals = buildEmployeeTotals(reportRows);

      createPdf({
        rows: reportRows,
        totals: reportTotals,
        range: { from: reportFrom, to: reportTo },
        schedule,
        device: payload.device || device,
        selectedEmployee,
        mode,
      });
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setDownloading(false);
    }
  }

  function updateRange(key, value) {
    const nextRange = { ...range, [key]: value };
    setRange(nextRange);
  }

  function updateSchedule(key, value) {
    setSchedule((current) => ({
      ...current,
      [key]: key.includes('Minutes') ? Math.max(0, Number(value || 0)) : value,
    }));
  }

  const isConnected = !error && fetchedAt;

  if (!currentUser) {
    return (
      <div className="login-page">
        <LoginWaveDecoration />
        <div className="login-card">
          <div className="login-header">
            <div className="login-logo-wrap">
              <AsistoLogo variant={theme === 'dark' ? 'dark' : 'light'} height={68} />
            </div>
            <p className="login-subtitle">Plataforma de control de asistencia</p>
            <span className="secure-badge">Acceso Seguro</span>
          </div>
          
          <form onSubmit={handleLogin} className="login-form">
            <div className="form-group">
              <label htmlFor="username">Usuario</label>
              <div className="input-with-icon">
                <User size={16} className="input-icon" />
                <input 
                  type="text" 
                  id="username" 
                  value={loginUsername} 
                  onChange={(e) => setLoginUsername(e.target.value)} 
                  placeholder="Usuario"
                  required 
                  autoComplete="username"
                />
              </div>
            </div>
            
            <div className="form-group">
              <label htmlFor="password">Contraseña</label>
              <div className="input-with-icon">
                <Lock size={16} className="input-icon" />
                <input 
                  type="password" 
                  id="password" 
                  value={loginPassword} 
                  onChange={(e) => setLoginPassword(e.target.value)} 
                  placeholder="Contraseña"
                  required 
                  autoComplete="current-password"
                />
              </div>
            </div>
            
            {loginError && (
              <div className="login-error" style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '10px', background: 'rgba(239, 68, 68, 0.1)', border: '1px solid rgba(239, 68, 68, 0.2)', borderRadius: '8px', color: '#ef4444', fontSize: '0.8rem', marginTop: '12px' }}>
                <AlertTriangle size={14} />
                <span>{loginError}</span>
              </div>
            )}
            
            <button type="submit" className="btn-login" disabled={loggingIn}>
              {loggingIn ? 'Iniciando sesión...' : 'Iniciar sesión'}
            </button>
          </form>
          
          <div className="login-footer">
            <span>ASISTO By ITZ | OIL &amp; GAS</span>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="app-layout">
      {/* Sidebar */}
      <aside className={`sidebar ${sidebarCollapsed ? 'collapsed' : ''}`}>
        <div className="sidebar-brand">
          <button
            type="button"
            className="sidebar-toggle"
            onClick={() => setSidebarCollapsed((current) => !current)}
            aria-label={sidebarCollapsed ? 'Abrir menú lateral' : 'Cerrar menú lateral'}
            title={sidebarCollapsed ? 'Abrir menú lateral' : 'Cerrar menú lateral'}
          >
            {sidebarCollapsed ? <AsistoIcon size={34} /> : <Menu size={18} />}
          </button>
          <div className="brand-block">
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <AsistoIcon size={30} style={{ border: '1px solid rgba(255,255,255,0.14)', borderRadius: '7px' }} />
              <AsistoLogo variant="dark" height={34} />
            </div>
            <p>Plataforma de control de asistencia</p>
          </div>
        </div>

        <div className="sidebar-device-select">
          <span className="section-label">Dispositivo Activo</span>
          <select 
            className="device-dropdown" 
            value={activeDeviceId} 
            onChange={(e) => {
              const newId = e.target.value;
              setActiveDeviceId(newId);
              loadEvents(range, newId);
            }}
          >
             {devices.map((d) => (
               <option key={d.id} value={d.id}>
                 {d.name} ({d.ip})
               </option>
             ))}
             {devices.length === 0 && (
               <option value={device.id || 'dev-default'}>{device.name || 'ZKTeco'} ({device.ip})</option>
             )}
          </select>
        </div>

        <nav className="sidebar-nav">
          <span className="section-label">Navegación</span>
          <button 
            className={`nav-item ${activeTab === 'general' ? 'active' : ''}`}
            onClick={() => setActiveTab('general')}
            title="Panel General / Reportes"
          >
            <IconReportes size={19} />
            <span className="nav-label">Panel General</span>
          </button>
          <button 
            className={`nav-item ${activeTab === 'asistencias' ? 'active' : ''}`}
            onClick={() => setActiveTab('asistencias')}
            title="Asistencia por Rango de Fecha"
          >
            <IconAsistencia size={19} />
            <span className="nav-label">Asistencia</span>
          </button>
          <button 
            className={`nav-item ${activeTab === 'eventos' ? 'active' : ''}`}
            onClick={() => setActiveTab('eventos')}
            title="Entradas / Salidas e Historial"
          >
            <IconEntradasSalidas size={19} />
            <span className="nav-label">Entradas / Salidas</span>
          </button>
          <button 
            className={`nav-item ${activeTab === 'colaboradores' ? 'active' : ''}`}
            onClick={() => setActiveTab('colaboradores')}
            title="Personal y Colaboradores"
          >
            <IconPersonal size={19} />
            <span className="nav-label">Personal</span>
          </button>
          {currentUser && currentUser.role === 'admin' && (
            <button 
              className={`nav-item ${activeTab === 'usuarios' ? 'active' : ''}`}
              onClick={() => setActiveTab('usuarios')}
              title="Configuración de Usuarios del Portal"
            >
              <IconConfiguracion size={19} />
              <span className="nav-label">Usuarios Portal</span>
            </button>
          )}
        </nav>

        <div className="sidebar-footer">
          {currentUser && (
            <div className="sidebar-user-block" style={{ borderBottom: '1px solid rgba(255,255,255,0.08)', paddingBottom: '12px', marginBottom: '12px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <div style={{
                  width: '28px',
                  height: '28px',
                  borderRadius: '50%',
                  background: 'var(--primary)',
                  color: 'white',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  fontSize: '0.74rem',
                  fontWeight: 'bold',
                  flexShrink: 0
                }}>
                  {getInitials(currentUser.username)}
                </div>
                <div style={{ display: sidebarCollapsed ? 'none' : 'block' }}>
                  <div style={{ fontSize: '0.78rem', fontWeight: 'bold', color: '#ffffff', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: '120px' }}>
                    {currentUser.username}
                  </div>
                  <div style={{ fontSize: '0.68rem', color: 'rgba(255,255,255,0.6)', textTransform: 'uppercase', fontWeight: 600 }}>
                    {currentUser.role === 'admin' ? 'Administrador' : 'Operador'}
                  </div>
                </div>
              </div>
              {!sidebarCollapsed && (
                <button 
                  onClick={handleLogout} 
                  className="btn-action btn-action-secondary" 
                  style={{ minHeight: '26px', fontSize: '0.72rem', width: '100%', marginTop: '8px', padding: '0 8px', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '4px' }}
                >
                  Cerrar Sesión
                </button>
              )}
            </div>
          )}
          <div className="sidebar-status">
            <span className={`status-dot ${isConnected ? 'online' : 'offline'}`} />
            {isConnected ? 'Dispositivo Online' : 'Dispositivo Offline'}
          </div>
          <div>Logs en equipo: {deviceInfo?.logCounts ?? '-'}</div>
          <div>Última sincro: {fetchedAt ? dateTimeLabel(fetchedAt) : '-'}</div>
          
          <div className="sidebar-theme-toggle">
            <Sun size={12} className={theme === 'light' ? 'active' : ''} />
            <button 
              className={`theme-toggle-switch ${theme === 'dark' ? 'dark' : ''}`}
              onClick={() => setTheme((current) => (current === 'light' ? 'dark' : 'light'))}
              aria-label={theme === 'light' ? 'Cambiar a modo oscuro' : 'Cambiar a modo claro'}
              title={theme === 'light' ? 'Cambiar a modo oscuro' : 'Cambiar a modo claro'}
            >
              <span className="switch-knob" />
            </button>
            <Moon size={12} className={theme === 'dark' ? 'active' : ''} />
            <span style={{ fontSize: '0.72rem', fontWeight: 600, marginLeft: '6px' }}>Modo Oscuro</span>
          </div>
        </div>
      </aside>

      {/* Main Content */}
      <div className="main-content">
        <header className="top-header">
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <h2>{
              activeTab === 'general' ? 'Panel General' :
              activeTab === 'asistencias' ? 'Asistencia' :
              activeTab === 'eventos' ? 'Entradas / Salidas' :
              activeTab === 'colaboradores' ? 'Personal' :
              activeTab === 'usuarios' ? 'Usuarios Portal' : 'Configuración'
            }</h2>
          </div>
          <div className="header-actions">
            <AsistoLogo variant="dark" height={24} showSubtitle={false} />
          </div>
        </header>

        <div className="content-body">
          {error && (
            <div className="alert-box">
              <AlertTriangle size={18} />
              <span>{error}</span>
            </div>
          )}

          {activeTab === 'general' && (
            <>
              {/* Row 1: Top Row */}
              <div className="top-row">
                <div className="card top-summary-card">
                  <span className="badge-active">Sistema Activo</span>
                  <h3>Plataforma de Control de Asistencia</h3>
                  <p className="panel-description">
                    Monitorea de forma centralizada la asistencia, puntualidad y horas extras.
                    Sincroniza datos en tiempo real y descarga reportes PDF listos para el pago
                    de la quincena.
                  </p>
                </div>

                <div className="card top-punctual-card">
                  <span className="section-chip" style={{ background: 'var(--primary-soft)', color: 'var(--primary)', border: '1px solid color-mix(in srgb, var(--primary) 18%, transparent)' }}>
                    Puntualidad
                  </span>
                  <h3>Más Temprano Llegaron</h3>
                  <div className="punctual-list">
                    {topPunctualEmployees.length > 0 ? (
                      topPunctualEmployees.map((emp, index) => (
                        <div key={emp.employeeId} className="punctual-item">
                          <span className="punctual-rank">{index + 1}</span>
                          <span className="punctual-name" title={emp.employeeName}>{emp.employeeName}</span>
                          <span className="punctual-time">{emp.formattedTime}</span>
                        </div>
                      ))
                    ) : (
                      <div className="punctual-empty">Sin datos de marcación</div>
                    )}
                  </div>
                </div>

                <div className="card quick-attendance-card top-quick-card">
                  <div className="quick-attendance-head compact">
                    <div>
                      <span className="section-chip">Reportes</span>
                      <h3>Quincena</h3>
                      <p className="chart-subtitle">PDF consolidado con todos los empleados y datos completos del periodo actual.</p>
                    </div>
                  </div>

                  <div className="quick-attendance-meta compact">
                    <div>
                      <span className="quick-meta-label">Periodo</span>
                      <strong>{dateLabel(range.from)} - {dateLabel(range.to)}</strong>
                    </div>
                  </div>

                  <button
                    className="btn-action btn-action-primary quick-download-btn"
                    onClick={() => downloadReport('consolidated')}
                    disabled={downloading || loading}
                  >
                    <FileDown size={16} className={downloading ? 'spin' : ''} />
                    {downloading ? 'Generando PDF...' : 'Descargar PDF'}
                  </button>
                </div>

                <div className="card top-device-card">
                  <span className={`lector-badge-online ${isConnected ? 'online' : 'offline'}`}>
                    {isConnected ? 'Online' : 'Offline'}
                  </span>
                  <h3>Lector Biométrico</h3>
                  <div className="lector-details">
                    <div className="lector-detail-row">
                      <span className="lector-detail-label">Nombre:</span>
                      <span className="lector-detail-value">{device.name || 'ZKTeco'}</span>
                    </div>
                    <div className="lector-detail-row">
                      <span className="lector-detail-label">Lector IP:</span>
                      <span className="lector-detail-value">{device.ip}:{device.port}</span>
                    </div>
                    <div className="lector-detail-row">
                      <span className="lector-detail-label">Logs en Memoria:</span>
                      <span className="lector-detail-value">{deviceInfo?.logCounts ?? '-'}</span>
                    </div>
                    <div className="lector-detail-row">
                      <span className="lector-detail-label">Sincronizado:</span>
                      <span className="lector-detail-value">{fetchedAt ? timeLabel(fetchedAt) : '-'}</span>
                    </div>
                  </div>
                  <div className="lector-actions">
                    <button className="btn-action btn-action-secondary" onClick={() => loadEvents()} disabled={loading}>Probar IP</button>
                    <button className="btn-action btn-action-primary" onClick={() => loadEvents()} disabled={loading}>Sincronizar</button>
                  </div>
                </div>
              </div>

              {/* Row 2: Metrics Row con Iconografía Oficial ASISTO */}
              <div className="metrics-row">
                <div className="card metric-card">
                  <div className="metric-header">
                    <span>ENTRADAS / SALIDAS</span>
                    <IconEntradasSalidas size={18} />
                  </div>
                  <div className="metric-body">
                    <span className="metric-val">{visibleEvents.length}</span>
                    <span className="metric-sub">Marcaciones filtradas</span>
                  </div>
                </div>
                <div className="card metric-card">
                  <div className="metric-header">
                    <span>PERSONAL</span>
                    <IconPersonal size={18} />
                  </div>
                  <div className="metric-body">
                    <span className="metric-val">{totals.length}</span>
                    <span className="metric-sub">Personal registrado</span>
                  </div>
                </div>
                <div className="card metric-card">
                  <div className="metric-header">
                    <span>ASISTENCIA</span>
                    <IconAsistencia size={18} />
                  </div>
                  <div className="metric-body">
                    <span className="metric-val">{durationLabel(totalWorked)}</span>
                    <span className="metric-sub">Horas acumuladas</span>
                  </div>
                </div>
                <div className="card metric-card warn">
                  <div className="metric-header">
                    <span>INCIDENCIAS</span>
                    <IconIncidencias size={18} />
                  </div>
                  <div className="metric-body">
                    <span className="metric-val">{totalLates}</span>
                    <span className="metric-sub">Total retardos</span>
                  </div>
                </div>
                <div className="card metric-card accent">
                  <div className="metric-header">
                    <span>REPORTES / EXTRA</span>
                    <IconReportes size={18} />
                  </div>
                  <div className="metric-body">
                    <span className="metric-val">{durationLabel(totalOvertime)}</span>
                    <span className="metric-sub">Acumulado adicional</span>
                  </div>
                </div>
              </div>

              {/* Row 3: Charts Row */}
              <div className="charts-row">
                <div className="card chart-container-card">
                  <h3>Horas Trabajadas vs Programadas</h3>
                  <p className="chart-subtitle">Comparación diaria entre el tiempo real trabajado y el horario esperado.</p>
                  <div style={{ height: 180, marginTop: '12px' }}>
                    <ResponsiveContainer width="100%" height="100%">
                      <LineChart data={dailyWorkData}>
                        <CartesianGrid stroke={chartTheme.grid} strokeDasharray="3 3" />
                        <XAxis dataKey="date" stroke={chartTheme.axis} fontSize={11} tickFormatter={(val) => val.slice(0, 5)} tickLine={false} axisLine={false} />
                        <YAxis stroke={chartTheme.axis} fontSize={11} tickLine={false} axisLine={false} />
                        <RechartsTooltip 
                          contentStyle={{ backgroundColor: chartTheme.tooltipBg, borderColor: chartTheme.tooltipBorder, color: chartTheme.tooltipText }}
                          formatter={(value, name) => [
                            `${Number(value).toFixed(1)} h`,
                            name === 'workedHours' ? 'Horas trabajadas' : 'Horas programadas',
                          ]}
                          labelFormatter={(label) => `Día ${label}`}
                        />
                        <Line type="monotone" dataKey="workedHours" stroke={chartTheme.workedLine} strokeWidth={3} dot={{ fill: chartTheme.workedLine, strokeWidth: 2, r: 4 }} activeDot={{ r: 6 }} />
                        <Line type="monotone" dataKey="scheduledHours" stroke={chartTheme.plannedLine} strokeWidth={2.5} dot={{ fill: chartTheme.plannedLine, strokeWidth: 2, r: 3 }} strokeDasharray="5 5" />
                      </LineChart>
                    </ResponsiveContainer>
                  </div>
                </div>
                <div className="card chart-container-card">
                  <h3>Incidencias por Empleado</h3>
                  <p className="chart-subtitle">Top de colaboradores con más retardos, salidas tempranas o días incompletos.</p>
                  <div style={{ height: 180, marginTop: '12px' }}>
                    <ResponsiveContainer width="100%" height="100%">
                      <BarChart data={topIssueEmployees} layout="vertical" margin={{ left: 8, right: 8 }}>
                        <CartesianGrid stroke={chartTheme.grid} strokeDasharray="3 3" />
                        <XAxis type="number" stroke={chartTheme.axis} fontSize={11} tickLine={false} axisLine={false} allowDecimals={false} />
                        <YAxis dataKey="employeeName" type="category" stroke={chartTheme.axis} fontSize={11} tickLine={false} axisLine={false} width={90} />
                        <RechartsTooltip
                          contentStyle={{ backgroundColor: chartTheme.tooltipBg, borderColor: chartTheme.tooltipBorder, color: chartTheme.tooltipText }}
                          formatter={(value, name) => [
                            value,
                            name === 'lateCount' ? 'Retardos' : name === 'earlyLeaveCount' ? 'Salidas tempranas' : 'Días incompletos',
                          ]}
                          labelFormatter={(label) => label}
                        />
                        <Bar dataKey="lateCount" fill={chartTheme.lateBar} radius={[0, 6, 6, 0]} />
                        <Bar dataKey="earlyLeaveCount" fill={chartTheme.earlyBar} radius={[0, 6, 6, 0]} />
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
                </div>

                <div className="card chart-container-card" style={{ display: 'flex', flexDirection: 'column' }}>
                  <h3>Distribución de Asistencias</h3>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '16px', flex: 1, marginTop: '12px' }}>
                    {distributionData.length > 0 ? (
                      <>
                        <div style={{ width: '180px', height: '180px', flexShrink: 0 }}>
                          <ResponsiveContainer width="100%" height="100%">
                            <PieChart margin={{ top: 0, right: 0, bottom: 0, left: 0 }}>
                              <Pie
                                data={distributionData}
                                cx="50%"
                                cy="50%"
                                innerRadius={62}
                                outerRadius={82}
                                paddingAngle={3}
                                dataKey="value"
                                stroke="var(--surface)"
                                strokeWidth={2}
                              >
                                {distributionData.map((entry, index) => (
                                  <Cell key={`cell-${index}`} fill={entry.color} />
                                ))}
                              </Pie>
                            </PieChart>
                          </ResponsiveContainer>
                        </div>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', justifyContent: 'center' }}>
                          {distributionData.map((d, index) => (
                            <div key={index} style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '0.75rem', whiteSpace: 'nowrap' }}>
                              <span style={{ width: '8px', height: '8px', borderRadius: '50%', backgroundColor: d.color, flexShrink: 0 }} />
                              <span style={{ color: theme === 'dark' ? '#9ca3af' : '#6B7280' }}>{d.name}:</span>
                              <span style={{ color: theme === 'dark' ? '#ffffff' : '#1B1F24', fontWeight: 'bold' }}>{d.percentage}%</span>
                            </div>
                          ))}
                        </div>
                      </>
                    ) : (
                      <div style={{ color: '#6B7280', fontSize: '0.85rem' }}>Sin datos suficientes</div>
                    )}
                  </div>
                </div>
              </div>

              {/* Row 4: Módulos de la Plataforma */}
              <div className="modules-row">
                <h3 className="modules-section-title">Módulos de la Plataforma</h3>
                <div className="modules-grid">
                  <div className="card module-card" onClick={() => setActiveTab('asistencias')}>
                    <div className="module-icon-box" style={{ color: 'var(--text)' }}>
                       <IconAsistencia size={22} />
                    </div>
                    <h4>Asistencia y Reportes</h4>
                    <p>Configure filtros de quincenas, turnos, retardos y descargue planillas formateadas en PDF consolidado o por empleado.</p>
                  </div>

                  <div className="card module-card" onClick={() => setActiveTab('eventos')}>
                    <div className="module-icon-box" style={{ color: 'var(--text)' }}>
                       <IconEntradasSalidas size={22} />
                    </div>
                    <h4>Entradas / Salidas</h4>
                    <p>Revise el orden cronológico de marcaciones y lecturas recolectadas de manera detallada en el biométrico activo.</p>
                  </div>

                  {(currentUser?.role === 'admin' || (currentUser?.assignedDevices || []).length > 0) && (
                    <div className="card module-card" onClick={openConfigModal}>
                      <div className="module-icon-box" style={{ color: 'var(--text)' }}>
                        <IconConfiguracion size={22} />
                      </div>
                      <h4>Configuración de Biométricos</h4>
                      <p>
                        {currentUser?.role === 'admin'
                          ? 'Gestione múltiples relojes biométricos, configure IPs y puertos, y prepare operaciones avanzadas.'
                          : 'Configure horarios, turnos y minutos de tolerancia de los biométricos que tiene asignados.'}
                      </p>
                    </div>
                  )}
                </div>
              </div>
            </>
          )}

          {activeTab === 'asistencias' && (
            <>
              <div className="tab-header">
                <h3 style={{ margin: 0 }}>Consultar Asistencias Diarias</h3>
              </div>
              
              <div className="filters-panel">
                <div className="field">
                  <label htmlFor="from-date">Desde</label>
                  <input
                    id="from-date"
                    type="date"
                    value={range.from}
                    onChange={(event) => updateRange('from', event.target.value)}
                  />
                </div>

                <div className="field">
                  <label htmlFor="to-date">Hasta</label>
                  <input
                    id="to-date"
                    type="date"
                    value={range.to}
                    onChange={(event) => updateRange('to', event.target.value)}
                  />
                </div>

                <div className="field">
                  <label htmlFor="employee">Empleado</label>
                  <select
                    id="employee"
                    value={selectedEmployee}
                    onChange={(event) => setSelectedEmployee(event.target.value)}
                  >
                    <option value="all">Todos</option>
                    {employees.map((employee) => (
                      <option key={employee.employeeId} value={employee.employeeId}>
                        {employee.employeeId} - {employee.name}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="field">
                  <label htmlFor="employee-search">Buscar</label>
                  <div className="input-with-icon">
                    <Search size={16} />
                    <input
                      id="employee-search"
                      type="search"
                      value={employeeQuery}
                      onChange={(event) => setEmployeeQuery(event.target.value)}
                      placeholder="Nombre o ID..."
                    />
                  </div>
                </div>

                <button className="btn-action btn-action-primary" onClick={() => loadEvents()} disabled={loading}>
                  <CalendarDays size={16} /> Consultar
                </button>

                <button 
                  className="btn-action btn-action-secondary" 
                  onClick={() => downloadReport('consolidated')} 
                  disabled={downloading || loading}
                  title="Descargar reporte PDF completo (Consolidado)"
                >
                  <FileDown size={16} className={downloading ? 'spin' : ''} /> PDF Completo
                </button>

                <button 
                  className="btn-action btn-action-secondary" 
                  onClick={() => downloadReport('individual_files')} 
                  disabled={downloading || loading}
                  title="Descargar reportes PDF individuales por empleado"
                >
                  <FileDown size={16} className={downloading ? 'spin' : ''} /> PDF por Empleado
                </button>
              </div>

              <div className="table-card">
                <h3>Resumen del Periodo</h3>
                <div className="table-responsive">
                  <table>
                    <thead>
                      <tr>
                        <th>Fecha</th>
                        <th>No.</th>
                        <th>Empleado</th>
                        <th>Entrada</th>
                        <th>Salida</th>
                        <th>Trabajadas</th>
                        <th>Retardo</th>
                        <th>S. Temp.</th>
                        <th>Extra</th>
                        <th>Estado</th>
                      </tr>
                    </thead>
                    <tbody>
                      {summaryRows.map((row) => (
                        <tr key={`${row.employeeId}-${row.dateKey}`}>
                          <td>{dateLabel(row.dateKey)}</td>
                          <td>{row.employeeId}</td>
                          <td>{row.employeeName}</td>
                          <td>{row.firstPunch ? timeLabel(row.firstPunch) : '-'}</td>
                          <td>{row.lastPunch && !row.isIncomplete ? timeLabel(row.lastPunch) : '-'}</td>
                          <td>{durationLabel(row.workedMinutes)}</td>
                          <td>{row.isLate ? `${row.lateMinutes} min` : '-'}</td>
                          <td>{row.isEarlyLeave ? `${row.earlyLeaveMinutes} min` : '-'}</td>
                          <td>{durationLabel(row.overtimeMinutes)}</td>
                          <td>
                            <span className={`status-pill ${row.isEarlyLeave && row.isLate ? 'early' : row.isLate ? 'late' : row.isEarlyLeave ? 'early' : row.isIncomplete ? 'open' : 'ok'}`}>
                              {row.status}
                            </span>
                          </td>
                        </tr>
                      ))}
                      {!summaryRows.length && (
                        <tr>
                          <td colSpan="10" className="empty-cell">Sin registros para los filtros actuales</td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
            </>
          )}

          {activeTab === 'eventos' && (
            <>
              <div className="tab-header">
                <h3 style={{ margin: 0 }}>Historial Completo de Eventos</h3>
              </div>

              <div className="filters-panel" style={{ marginBottom: '20px' }}>
                <div className="field" style={{ flex: '1 1 300px' }}>
                  <label htmlFor="employee-search">Buscar Colaborador</label>
                  <div className="input-with-icon">
                    <Search size={16} />
                    <input
                      id="employee-search"
                      type="search"
                      value={employeeQuery}
                      onChange={(event) => setEmployeeQuery(event.target.value)}
                      placeholder="Buscar por ID o Nombre..."
                    />
                  </div>
                </div>
                
                <button className="btn-action btn-action-primary" onClick={() => loadEvents()} disabled={loading}>
                  <RefreshCw size={16} className={loading ? 'spin' : ''} /> Actualizar Datos
                </button>
              </div>

              <div className="split-tables-container">
                <div className="table-card">
                  <h3>Totales por Empleado</h3>
                  <div className="table-responsive">
                    <table>
                      <thead>
                        <tr>
                          <th style={{ width: '50px' }}>No.</th>
                          <th>Empleado</th>
                          <th style={{ width: '70px', textAlign: 'center' }}>Días</th>
                          <th style={{ width: '80px' }}>Horas</th>
                          <th style={{ width: '80px', textAlign: 'center' }}>Retardos</th>
                          <th style={{ width: '140px', textAlign: 'center' }}>S. Temp. (Minutos)</th>
                          <th style={{ width: '80px' }}>Extra</th>
                          <th style={{ width: '100px', textAlign: 'center' }}>Incompletos</th>
                        </tr>
                      </thead>
                      <tbody>
                        {totals.map((row) => (
                          <tr key={row.employeeId}>
                            <td style={{ fontWeight: '600', color: 'var(--text-soft)' }}>{row.employeeId}</td>
                            <td>
                              {editingEmployeeId === row.employeeId ? (
                                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                                  <input
                                    type="text"
                                    style={{
                                      padding: '4px 8px',
                                      borderRadius: '6px',
                                      border: '1px solid var(--primary)',
                                      fontSize: '0.8rem',
                                      background: 'var(--surface-alt)',
                                      color: 'var(--text)',
                                      fontWeight: '600',
                                      width: '180px',
                                      outline: 'none'
                                    }}
                                    value={editingEmployeeName}
                                    onChange={(e) => setEditingEmployeeName(e.target.value)}
                                    autoFocus
                                    onKeyDown={(e) => {
                                      if (e.key === 'Enter') handleSaveEmployeeName(row.employeeId);
                                      if (e.key === 'Escape') setEditingEmployeeId('');
                                    }}
                                  />
                                  <button
                                    className="btn-action btn-action-primary"
                                    style={{ minHeight: '26px', padding: '0 8px', width: 'auto', fontSize: '0.74rem' }}
                                    onClick={() => handleSaveEmployeeName(row.employeeId)}
                                  >
                                    Guardar
                                  </button>
                                  <button
                                    className="btn-action btn-action-secondary"
                                    style={{ minHeight: '26px', padding: '0 8px', width: 'auto', fontSize: '0.74rem' }}
                                    onClick={() => setEditingEmployeeId('')}
                                  >
                                    Cancelar
                                  </button>
                                </div>
                              ) : (
                                <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                                  <div 
                                    style={{ 
                                      width: '32px', 
                                      height: '32px', 
                                      borderRadius: '50%', 
                                      background: getAvatarBackground(row.employeeId),
                                      color: '#ffffff',
                                      display: 'flex',
                                      alignItems: 'center',
                                      justifyContent: 'center',
                                      fontSize: '0.78rem',
                                      fontWeight: 'bold',
                                      boxShadow: '0 2px 5px rgba(0,0,0,0.1)',
                                      flexShrink: 0
                                    }}
                                  >
                                    {getInitials(row.employeeName)}
                                  </div>
                                  <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                                    <span style={{ fontWeight: '600', color: 'var(--text)' }}>{row.employeeName}</span>
                                    <button
                                      style={{
                                        color: 'var(--primary)',
                                        background: 'none',
                                        border: 'none',
                                        cursor: 'pointer',
                                        padding: '2px',
                                        display: 'inline-flex',
                                        alignItems: 'center',
                                        justifyContent: 'center',
                                        opacity: 0.6,
                                        transition: 'opacity 0.2s'
                                      }}
                                      onMouseEnter={(e) => e.currentTarget.style.opacity = 1}
                                      onMouseLeave={(e) => e.currentTarget.style.opacity = 0.6}
                                      onClick={() => {
                                        setEditingEmployeeId(row.employeeId);
                                        setEditingEmployeeName(row.employeeName);
                                      }}
                                      title="Editar nombre en plataforma"
                                    >
                                      <Edit size={13} />
                                    </button>
                                  </div>
                                </div>
                              )}
                            </td>
                            <td style={{ textAlign: 'center', fontWeight: '700' }}>{row.days}</td>
                            <td><strong style={{ color: 'var(--primary)' }}>{durationLabel(row.workedMinutes)}</strong></td>
                            <td style={{ textAlign: 'center' }}>
                              <span className={`status-pill ${row.lateCount > 0 ? 'late' : 'ok'}`} style={{ minWidth: '32px', textAlign: 'center', fontWeight: 'bold' }}>
                                {row.lateCount}
                              </span>
                            </td>
                            <td style={{ textAlign: 'center' }}>
                              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px' }}>
                                <span className={`status-pill ${row.earlyLeaveCount > 0 ? 'early' : 'ok'}`} style={{ minWidth: '32px', textAlign: 'center', fontWeight: 'bold' }}>
                                  {row.earlyLeaveCount}
                                </span>
                                {row.earlyLeaveMinutes > 0 && (
                                  <span style={{ fontSize: '0.8rem', fontWeight: '600', color: 'var(--text-soft)' }}>
                                    ({row.earlyLeaveMinutes} min)
                                  </span>
                                )}
                              </div>
                            </td>
                            <td>
                              {row.overtimeMinutes > 0 ? (
                                <span style={{ fontWeight: '700', color: 'var(--success)' }}>
                                  +{durationLabel(row.overtimeMinutes)}
                                </span>
                              ) : (
                                <span style={{ color: 'var(--text-soft)' }}>-</span>
                              )}
                            </td>
                            <td style={{ textAlign: 'center' }}>
                              <span className={`status-pill ${row.incompleteDays > 0 ? 'open' : 'ok'}`} style={{ minWidth: '32px', textAlign: 'center', fontWeight: 'bold' }}>
                                {row.incompleteDays}
                              </span>
                            </td>
                          </tr>
                        ))}
                        {!totals.length && (
                          <tr>
                            <td colSpan="8" className="empty-cell">Sin datos de colaboradores</td>
                          </tr>
                        )}
                      </tbody>
                    </table>
                  </div>
                </div>

                <div className="table-card">
                  <h3>Bitácora de Eventos</h3>
                  <div className="table-responsive">
                    <table>
                      <thead>
                        <tr>
                          <th>Fecha y hora</th>
                          <th>No.</th>
                          <th>Empleado</th>
                          <th>Evento</th>
                        </tr>
                      </thead>
                      <tbody>
                        {enrichedEvents.map((event) => (
                          <tr key={event.id}>
                            <td>{dateTimeLabel(event.timestamp)}</td>
                            <td>{event.employeeId}</td>
                            <td>{event.employeeName}</td>
                            <td>
                              <span className={`status-pill ${
                                event.eventType === 'Entrada' ? 'ok' :
                                event.eventType === 'Salida' ? 'open' :
                                event.eventType === 'Salida Temprana' ? 'early' : 'late'
                              }`}>
                                {event.eventType}
                              </span>
                            </td>
                          </tr>
                        ))}
                        {!enrichedEvents.length && (
                          <tr>
                            <td colSpan="4" className="empty-cell">Sin eventos cargados</td>
                          </tr>
                        )}
                      </tbody>
                    </table>
                  </div>
                </div>
              </div>
            </>
          )}

          {activeTab === 'colaboradores' && (
            <>
              <div className="tab-header">
                <h3 style={{ margin: 0 }}>Directorio de Colaboradores</h3>
                <button 
                  className="btn-action btn-action-primary" 
                  style={{ width: 'auto', minWidth: '180px' }}
                  onClick={downloadEmployeeList}
                  disabled={!employees.length}
                >
                  <FileDown size={16} /> Descargar Lista PDF
                </button>
              </div>

              <div className="table-card">
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '14px', flexWrap: 'wrap', gap: '10px' }}>
                  <h3 style={{ margin: 0 }}>Personal Registrado ({filteredEmployees.length})</h3>
                  <div style={{ position: 'relative', width: '250px' }}>
                    <input 
                      type="search" 
                      placeholder="Buscar por ID o Nombre..." 
                      style={{
                        padding: '6px 12px 6px 32px',
                        fontSize: '0.82rem',
                        borderRadius: '6px',
                        border: '1px solid var(--border)',
                        background: 'var(--surface-alt)',
                        color: 'var(--text)',
                        width: '100%',
                        outline: 'none'
                      }}
                      value={employeeQuery}
                      onChange={(e) => {
                        setEmployeeQuery(e.target.value);
                        setEmployeesPage(1); // Reset to page 1 on search
                      }}
                    />
                    <Search size={14} style={{ position: 'absolute', left: '10px', top: '50%', transform: 'translateY(-50%)', color: 'var(--text-soft)' }} />
                  </div>
                </div>

                <div className="table-responsive colaboradores-table-responsive">
                  <table>
                    <thead>
                      <tr>
                        <th style={{ width: '80px' }}>ID</th>
                        <th>Nombre Completo</th>
                        <th style={{ width: '150px' }}>Rol</th>
                        <th style={{ width: '150px' }}>No. Tarjeta</th>
                      </tr>
                    </thead>
                    <tbody>
                      {paginatedEmployees.map((emp) => (
                        <tr key={emp.employeeId}>
                          <td style={{ fontWeight: '600', color: 'var(--text-soft)' }}>{emp.employeeId}</td>
                          <td>
                            {editingEmployeeId === emp.employeeId ? (
                              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                                <input
                                  type="text"
                                  style={{
                                    padding: '4px 8px',
                                    borderRadius: '6px',
                                    border: '1px solid var(--primary)',
                                    fontSize: '0.8rem',
                                    background: 'var(--surface-alt)',
                                    color: 'var(--text)',
                                    fontWeight: '600',
                                    width: '200px',
                                    outline: 'none'
                                  }}
                                  value={editingEmployeeName}
                                  onChange={(e) => setEditingEmployeeName(e.target.value)}
                                  autoFocus
                                  onKeyDown={(e) => {
                                    if (e.key === 'Enter') handleSaveEmployeeName(emp.employeeId);
                                    if (e.key === 'Escape') setEditingEmployeeId('');
                                  }}
                                />
                                <button
                                  className="btn-action btn-action-primary"
                                  style={{ minHeight: '26px', padding: '0 8px', width: 'auto', fontSize: '0.74rem' }}
                                  onClick={() => handleSaveEmployeeName(emp.employeeId)}
                                >
                                  Guardar
                                </button>
                                <button
                                  className="btn-action btn-action-secondary"
                                  style={{ minHeight: '26px', padding: '0 8px', width: 'auto', fontSize: '0.74rem' }}
                                  onClick={() => setEditingEmployeeId('')}
                                >
                                  Cancelar
                                </button>
                              </div>
                            ) : (
                              <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                                <div 
                                  style={{ 
                                    width: '30px', 
                                    height: '30px', 
                                    borderRadius: '50%', 
                                    background: getAvatarBackground(emp.employeeId),
                                    color: '#ffffff',
                                    display: 'flex',
                                    alignItems: 'center',
                                    justifyContent: 'center',
                                    fontSize: '0.76rem',
                                    fontWeight: 'bold',
                                    boxShadow: '0 2px 4px rgba(0,0,0,0.1)',
                                    flexShrink: 0
                                  }}
                                >
                                  {getInitials(emp.name)}
                                </div>
                                <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                                  <span style={{ fontWeight: '600', color: 'var(--text)' }}>{emp.name}</span>
                                  <button
                                    style={{
                                      color: 'var(--primary)',
                                      background: 'none',
                                      border: 'none',
                                      cursor: 'pointer',
                                      padding: '2px',
                                      display: 'inline-flex',
                                      alignItems: 'center',
                                      justifyContent: 'center',
                                      opacity: 0.6,
                                      transition: 'opacity 0.2s'
                                    }}
                                    onMouseEnter={(e) => e.currentTarget.style.opacity = 1}
                                    onMouseLeave={(e) => e.currentTarget.style.opacity = 0.6}
                                    onClick={() => {
                                      setEditingEmployeeId(emp.employeeId);
                                      setEditingEmployeeName(emp.name);
                                    }}
                                    title="Editar nombre en plataforma"
                                  >
                                    <Edit size={13} />
                                  </button>
                                </div>
                              </div>
                            )}
                          </td>
                          <td>
                            <span className={`status-pill ${emp.role === 14 ? 'late' : 'ok'}`}>
                                {emp.role === 14 ? 'Administrador' : 'Usuario Normal'}
                            </span>
                          </td>
                          <td style={{ color: 'var(--text-soft)', fontFamily: 'monospace', fontSize: '0.88rem' }}>
                            {emp.cardNo || '-'}
                          </td>
                        </tr>
                      ))}
                      {!filteredEmployees.length && (
                        <tr>
                          <td colSpan="4" className="empty-cell">Sin colaboradores registrados en el biométrico activo</td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>

                {totalEmployeePages > 1 && (
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: '16px', borderTop: '1px solid var(--border)', paddingTop: '14px', flexWrap: 'wrap', gap: '10px' }}>
                    <span style={{ fontSize: '0.8rem', color: 'var(--text-soft)', fontWeight: 600 }}>
                      Mostrando {Math.min(filteredEmployees.length, (employeesPage - 1) * employeeItemsPerPage + 1)} - {Math.min(filteredEmployees.length, employeesPage * employeeItemsPerPage)} de {filteredEmployees.length} colaboradores
                    </span>
                    <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
                      <button
                        className="btn-action btn-action-secondary"
                        style={{ minHeight: '30px', padding: '0 12px', width: 'auto', fontSize: '0.78rem' }}
                        disabled={employeesPage === 1}
                        onClick={() => setEmployeesPage(prev => Math.max(1, prev - 1))}
                      >
                        Anterior
                      </button>
                      {Array.from({ length: totalEmployeePages }, (_, idx) => idx + 1).map(pageNum => (
                        <button
                          key={pageNum}
                          className={`btn-action ${employeesPage === pageNum ? 'btn-action-primary' : 'btn-action-secondary'}`}
                          style={{ 
                            minHeight: '30px', 
                            width: '30px', 
                            padding: 0, 
                            fontSize: '0.78rem',
                            fontWeight: '700',
                            border: employeesPage === pageNum ? 'none' : '1px solid var(--border)'
                          }}
                          onClick={() => setEmployeesPage(pageNum)}
                        >
                          {pageNum}
                        </button>
                      ))}
                      <button
                        className="btn-action btn-action-secondary"
                        style={{ minHeight: '30px', padding: '0 12px', width: 'auto', fontSize: '0.78rem' }}
                        disabled={employeesPage === totalEmployeePages}
                        onClick={() => setEmployeesPage(prev => Math.min(totalEmployeePages, prev + 1))}
                      >
                        Siguiente
                      </button>
                    </div>
                  </div>
                )}
              </div>
            </>
          )}

          {activeTab === 'usuarios' && currentUser?.role === 'admin' && (
            <>
              <div className="tab-header">
                <h3 style={{ margin: 0 }}>Administración de Usuarios del Portal</h3>
                <button 
                  className="btn-action btn-action-primary" 
                  style={{ width: 'auto', minWidth: '180px' }}
                  onClick={startCreateUser}
                >
                  <Plus size={16} /> Crear Usuario
                </button>
              </div>

              <div className="split-tables-container" style={{ display: 'grid', gridTemplateColumns: selectedUserEdit ? '1fr 1.2fr' : '1fr', gap: '20px' }}>
                <div className="table-card">
                  <h3>Usuarios Registrados</h3>
                  <div className="table-responsive">
                    <table>
                      <thead>
                        <tr>
                          <th>Usuario</th>
                          <th>Rol</th>
                          <th>Biométricos Asignados</th>
                          <th style={{ width: '120px' }}>Acciones</th>
                        </tr>
                      </thead>
                      <tbody>
                        {portalUsers.map((u) => (
                          <tr key={u.id}>
                            <td style={{ fontWeight: '600' }}>{u.username}</td>
                            <td>
                              <span className={`status-pill ${u.role === 'admin' ? 'late' : 'ok'}`}>
                                {u.role === 'admin' ? 'Administrador' : 'Operador'}
                              </span>
                            </td>
                            <td>
                              {u.role === 'admin' ? (
                                <span style={{ color: 'var(--text-soft)', fontStyle: 'italic' }}>Todos (Acceso Total)</span>
                              ) : (
                                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px' }}>
                                  {(u.assignedDevices || []).map((devId) => {
                                    const devObj = devices.find(d => d.id === devId);
                                    return (
                                      <span key={devId} className="status-pill info" style={{ fontSize: '0.7rem', padding: '2px 6px' }}>
                                        {devObj ? devObj.name : devId}
                                      </span>
                                    );
                                  })}
                                  {(!u.assignedDevices || u.assignedDevices.length === 0) && (
                                    <span style={{ color: 'var(--danger)', fontSize: '0.74rem', fontWeight: 600 }}>Ninguno (Sin Acceso)</span>
                                  )}
                                </div>
                              )}
                            </td>
                            <td>
                              <div style={{ display: 'flex', gap: '6px' }}>
                                <button
                                  className="btn-action btn-action-secondary"
                                  style={{ minHeight: '28px', padding: '0 8px', width: 'auto', fontSize: '0.74rem' }}
                                  onClick={() => startEditUser(u)}
                                >
                                  <Edit size={12} /> Editar
                                </button>
                                <button
                                  className="btn-action btn-action-secondary"
                                  style={{ minHeight: '28px', padding: '0 8px', width: 'auto', fontSize: '0.74rem', color: 'var(--danger)' }}
                                  onClick={() => handleDeleteUser(u.id)}
                                  disabled={u.id === 'usr-admin'}
                                >
                                  <Trash2 size={12} />
                                </button>
                              </div>
                            </td>
                          </tr>
                        ))}
                        {!portalUsers.length && (
                          <tr>
                            <td colSpan="4" className="empty-cell">No hay usuarios registrados.</td>
                          </tr>
                        )}
                      </tbody>
                    </table>
                  </div>
                </div>

                {selectedUserEdit && (
                  <div className="table-card">
                    <h3>{selectedUserEdit === 'new' ? 'Crear Nuevo Usuario' : 'Editar Usuario'}</h3>
                    <form onSubmit={handleSaveUser} style={{ display: 'flex', flexDirection: 'column', gap: '16px', marginTop: '14px' }}>
                      <div className="field">
                        <label>Nombre de Usuario</label>
                        <input
                          type="text"
                          value={userFormUsername}
                          onChange={(e) => setUserFormUsername(e.target.value)}
                          placeholder="Ej. supervisor"
                          required
                          style={{ background: 'var(--surface-alt)', color: 'var(--text)', border: '1px solid var(--border)', padding: '8px', borderRadius: '6px' }}
                        />
                      </div>

                      <div className="field">
                        <label>Contraseña {selectedUserEdit !== 'new' && '(dejar en blanco para no cambiar)'}</label>
                        <input
                          type="password"
                          value={userFormPassword}
                          onChange={(e) => setUserFormPassword(e.target.value)}
                          placeholder={selectedUserEdit === 'new' ? 'Contraseña del usuario' : '••••••••'}
                          required={selectedUserEdit === 'new'}
                          style={{ background: 'var(--surface-alt)', color: 'var(--text)', border: '1px solid var(--border)', padding: '8px', borderRadius: '6px' }}
                        />
                      </div>

                      <div className="field">
                        <label>Rol del Usuario</label>
                        <select
                          value={userFormRole}
                          onChange={(e) => setUserFormRole(e.target.value)}
                          style={{ background: 'var(--surface-alt)', color: 'var(--text)', border: '1px solid var(--border)', padding: '8px', borderRadius: '6px' }}
                        >
                          <option value="user">Operador (Acceso Restringido)</option>
                          <option value="admin">Administrador (Acceso Total)</option>
                        </select>
                      </div>

                      {userFormRole === 'user' && (
                        <div className="field">
                          <label style={{ marginBottom: '6px', display: 'block' }}>Biométricos Asignados</label>
                          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', background: 'var(--surface-alt)', padding: '12px', borderRadius: '8px', border: '1px solid var(--border)', maxHeight: '180px', overflowY: 'auto' }}>
                            {devices.map((dev) => (
                              <label key={dev.id} style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer', fontSize: '0.82rem', fontWeight: 600 }}>
                                <input
                                  type="checkbox"
                                  checked={userFormDevices.includes(dev.id)}
                                  onChange={(e) => {
                                    if (e.target.checked) {
                                      setUserFormDevices(prev => [...prev, dev.id]);
                                    } else {
                                      setUserFormDevices(prev => prev.filter(id => id !== dev.id));
                                    }
                                  }}
                                  style={{ cursor: 'pointer' }}
                                />
                                {dev.name} ({dev.ip})
                              </label>
                            ))}
                            {devices.length === 0 && (
                              <span style={{ color: 'var(--text-soft)', fontSize: '0.78rem', fontStyle: 'italic' }}>No hay biométricos registrados.</span>
                            )}
                          </div>
                        </div>
                      )}

                      <div style={{ display: 'flex', gap: '10px', marginTop: '10px' }}>
                        <button type="submit" className="btn-action btn-action-primary" style={{ width: 'auto' }}>
                          Guardar Usuario
                        </button>
                        <button type="button" className="btn-action btn-action-secondary" style={{ width: 'auto' }} onClick={() => setSelectedUserEdit(null)}>
                          Cancelar
                        </button>
                      </div>
                    </form>
                  </div>
                )}
              </div>
            </>
          )}

        </div>

        {/* Centered Settings Modal (Two-Column Layout) */}
        {isConfigOpen && (
          <div className="modal-overlay" onClick={() => setIsConfigOpen(false)}>
            <div className="modal-content config-modal-content" onClick={(e) => e.stopPropagation()}>
              <div className="modal-header">
                <div>
                  <h3 style={{ fontSize: '1.1rem', fontWeight: 800 }}>Administrador de Biométricos</h3>
                  <p className="modal-subtitle" style={{ fontSize: '0.74rem', color: 'var(--text-soft)', margin: '4px 0 0 0' }}>
                    Gestione la conexión y los horarios de entrada/salida de cada biométrico.
                  </p>
                </div>
                <button className="close-btn" onClick={() => setIsConfigOpen(false)} aria-label="Cerrar">&times;</button>
              </div>
              
              <div className="modal-body config-modal-body">
                {/* Left Panel: Device List */}
                <div className="modal-devices-sidebar">
                  <div className="sidebar-list-header">
                    <span>Dispositivos</span>
                    {currentUser?.role === 'admin' && (
                      <button 
                        className="btn-add-device" 
                        onClick={addNewDeviceForEdit}
                        title="Agregar nuevo biométrico"
                      >
                        <Plus size={12} /> Nuevo
                      </button>
                    )}
                  </div>
                  
                  <div className="devices-list-scroll">
                    {devices.map((d) => (
                      <div 
                        key={d.id} 
                        className={`device-list-item ${selectedEditDeviceId === d.id ? 'active' : ''} ${activeDeviceId === d.id ? 'current-active' : ''}`}
                        onClick={() => selectDeviceForEdit(d)}
                      >
                        <div className="device-item-info">
                          <span className="device-item-name">{d.name}</span>
                          <span className="device-item-ip">{d.ip}</span>
                        </div>
                        <div className="device-item-actions">
                          {activeDeviceId === d.id && (
                            <span className="active-badge" title="Dispositivo activo para reportes">Activo</span>
                          )}
                          {currentUser?.role === 'admin' && (
                            <button 
                              className="btn-delete-device-item" 
                              onClick={(e) => handleDeleteDevice(d.id, e)}
                              title="Eliminar dispositivo"
                            >
                              <Trash2 size={12} />
                            </button>
                          )}
                        </div>
                      </div>
                    ))}
                    {devices.length === 0 && (
                      <div className="empty-devices-msg">No hay dispositivos registrados</div>
                    )}
                  </div>
                </div>

                {/* Right Panel: Selected Device Form */}
                <div className="modal-device-form-pane">
                  <div className="form-pane-header">
                    <h4>{selectedEditDeviceId === 'new' ? 'Nuevo Dispositivo' : 'Editar Dispositivo'}</h4>
                  </div>
                  
                  <div className="form-pane-scroll">
                    {/* Schedule Settings Section */}
                    <div className="form-card-section">
                      <div className="card-section-title">Horarios de Jornada</div>
                      
                      <div className="schedule-grid">
                        <div className="schedule-day-row">
                          <div className="day-label">Lunes a Viernes</div>
                          <div className="time-inputs-group">
                            <div className="time-field">
                              <span className="field-sublabel">Entrada</span>
                              <input
                                type="time"
                                value={editShiftStart}
                                onChange={(e) => setEditShiftStart(e.target.value)}
                              />
                            </div>
                            <span className="connector">a</span>
                            <div className="time-field">
                              <span className="field-sublabel">Salida</span>
                              <input
                                type="time"
                                value={editShiftEnd}
                                onChange={(e) => setEditShiftEnd(e.target.value)}
                              />
                            </div>
                          </div>
                        </div>

                        <div className="schedule-day-row">
                          <div className="day-label">Sábados</div>
                          <div className="time-inputs-group">
                            <div className="time-field">
                              <span className="field-sublabel">Entrada</span>
                              <input
                                type="time"
                                value={editSatShiftStart}
                                onChange={(e) => setEditSatShiftStart(e.target.value)}
                              />
                            </div>
                            <span className="connector">a</span>
                            <div className="time-field">
                              <span className="field-sublabel">Salida</span>
                              <input
                                type="time"
                                value={editSatShiftEnd}
                                onChange={(e) => setEditSatShiftEnd(e.target.value)}
                              />
                            </div>
                          </div>
                        </div>

                        <div className="schedule-day-row tolerance-row">
                          <div className="day-label">Tolerancia de entrada</div>
                          <div className="time-inputs-group">
                            <div className="numeric-field-wrap">
                              <input
                                type="number"
                                min="0"
                                max="120"
                                value={editGraceMinutes}
                                onChange={(e) => setEditGraceMinutes(Math.max(0, Number(e.target.value || 0)))}
                              />
                              <span className="field-unit">minutos</span>
                            </div>
                          </div>
                        </div>
                      </div>
                    </div>

                    {/* General Settings Section */}
                    <div className="form-card-section">
                      <div className="card-section-title">Conexión y Red</div>
                      <div className="fields-row-grid">
                        <div className="field">
                          <label htmlFor="edit-name">Nombre del Equipo</label>
                          <input
                            id="edit-name"
                            type="text"
                            placeholder="Ej. Oficina Central"
                            value={editName}
                            onChange={(e) => setEditName(e.target.value)}
                            disabled={currentUser?.role !== 'admin'}
                          />
                        </div>
                        <div className="field">
                          <label htmlFor="edit-model">Modelo</label>
                          <select
                            id="edit-model"
                            className="device-dropdown select-input"
                            style={{ padding: '8px 12px', height: '38px' }}
                            value={editModel}
                            onChange={(e) => setEditModel(e.target.value)}
                            disabled={currentUser?.role !== 'admin'}
                          >
                            <option value="WL20/EWL20">WL20/EWL20</option>
                            <option value="F22">F22</option>
                            <option value="MB160">MB160</option>
                            <option value="iClock">iClock Series</option>
                            <option value="K40">K40 / K20</option>
                          </select>
                        </div>
                      </div>
                      
                      <div className="fields-row-grid" style={{ marginTop: '10px' }}>
                        <div className="field">
                          <label htmlFor="edit-ip">Dirección IP</label>
                          <input
                            id="edit-ip"
                            type="text"
                            placeholder="192.168.1.100"
                            value={editIp}
                            onChange={(e) => setEditIp(e.target.value)}
                            disabled={currentUser?.role !== 'admin'}
                          />
                        </div>
                        <div className="field">
                          <label htmlFor="edit-port">Puerto</label>
                          <input
                            id="edit-port"
                            type="number"
                            value={editPort}
                            onChange={(e) => setEditPort(Number(e.target.value))}
                            disabled={currentUser?.role !== 'admin'}
                          />
                        </div>
                      </div>

                      {/* Connection Test Button and Results */}
                      <div className="connection-test-container">
                        <button
                          type="button"
                          className="btn-action btn-action-secondary btn-test-conn"
                          onClick={handleTestConnection}
                          disabled={testingConnection || !editIp}
                        >
                          <RefreshCw size={12} className={testingConnection ? 'spin' : ''} />
                          {testingConnection ? 'Probando...' : 'Probar Conexión'}
                        </button>
                        
                        {testResult && (
                          <div className={`test-feedback-box ${testResult.ok ? 'success' : 'error'}`}>
                            <span className="feedback-icon">{testResult.ok ? '✓' : '✗'}</span>
                            <span className="feedback-text">{testResult.message}</span>
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                </div>
              </div>

              <div className="modal-footer">
                <button className="btn-action btn-action-secondary" style={{ width: 'auto' }} onClick={() => setIsConfigOpen(false)}>
                  Cancelar
                </button>
                <button 
                  className="btn-action btn-action-primary" 
                  style={{ width: 'auto' }}
                  onClick={handleSaveConfig}
                  disabled={savingConfig || !editIp || !editName}
                >
                  {savingConfig ? 'Guardando...' : 'Guardar Cambios'}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

async function apiRequest(url, options = {}) {
  const token = window.localStorage.getItem('zkteco-token');
  const headers = {
    'Content-Type': 'application/json',
    ...options.headers,
  };
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  const response = await fetch(url, {
    ...options,
    headers,
  });

  if (response.status === 401) {
    window.localStorage.removeItem('zkteco-token');
    window.localStorage.removeItem('zkteco-user');
    window.location.reload();
    throw new Error('Sesión expirada. Inicie sesión nuevamente.');
  }

  const payload = await response.json().catch(() => ({}));

  if (!response.ok) {
    const error = new Error(payload.message || 'No se pudo completar la solicitud.');
    error.device = payload.device;
    throw error;
  }

  return payload;
}

async function getJson(url) {
  return apiRequest(url);
}

function drawAsistoPdfBrand(doc, x, y) {
  // Ícono cuadrado redondeado Grafito (#1B1F24)
  doc.setFillColor(27, 31, 36);
  doc.roundedRect(x, y, 28, 28, 6, 6, 'F');
  // Letra A blanca + barra Naranja ITZ (#FF7A00)
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(18);
  doc.setTextColor(255, 255, 255);
  doc.text('A', x + 7.5, y + 20.5);
  doc.setFillColor(255, 122, 0);
  doc.rect(x + 11, y + 14.5, 6.5, 2.5, 'F');

  // Wordmark ASISTO By ITZ | OIL & GAS
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(15);
  doc.setTextColor(27, 31, 36);
  doc.text('ASISTO', x + 34, y + 16);

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(6.5);
  doc.setTextColor(255, 122, 0);
  doc.text('By ITZ', x + 34, y + 25);
  doc.setTextColor(107, 114, 128);
  doc.text('| OIL & GAS', x + 57, y + 25);

  // Línea divisoria vertical después del logo
  doc.setDrawColor(229, 231, 235);
  doc.line(x + 114, y + 2, x + 114, y + 26);
}

function drawSummaryPage(doc, { totals, range, device }) {
  const generatedAt = new Date();

  // Top accent bar Grafito + Naranja ITZ
  doc.setFillColor(27, 31, 36);
  doc.rect(0, 0, 792, 6, 'F');
  doc.setFillColor(255, 122, 0);
  doc.rect(0, 6, 792, 3, 'F');

  // Brand mark left
  drawAsistoPdfBrand(doc, 40, 22);

  // Header Title
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(14);
  doc.setTextColor(27, 31, 36);
  doc.text('RESUMEN GENERAL DE ASISTENCIA Y NÓMINA', 166, 35);

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9);
  doc.setTextColor(107, 114, 128);
  doc.text('Consolidado general de colaboradores y tiempos acumulados del periodo', 166, 48);

  // Header Right
  doc.setFontSize(8.5);
  doc.text(`Generado: ${dateTimeLabel(generatedAt.toISOString())}`, 580, 35);
  doc.text(`Periodo: ${dateLabel(range.from)} al ${dateLabel(range.to)}`, 580, 48);

  // Divider line
  doc.setDrawColor(229, 231, 235);
  doc.line(40, 60, 752, 60);

  // Compute summary stats
  const totalEmployees = totals.length;
  const totalWorkedMinutes = totals.reduce((sum, t) => sum + t.workedMinutes, 0);
  const totalLateCount = totals.reduce((sum, t) => sum + t.lateCount, 0);
  const totalOvertimeMinutes = totals.reduce((sum, t) => sum + t.overtimeMinutes, 0);

  // KPI cards coords and styles
  const cardWidth = 166;
  const cardHeight = 46;
  const cardY = 70;
  const cardGap = 16;
  const cards = [
    { label: 'PERSONAL REGISTRADO', value: String(totalEmployees), color: [27, 31, 36] },
    { label: 'TIEMPO TOTAL TRAB.', value: durationLabel(totalWorkedMinutes), color: [16, 185, 129] },
    { label: 'TOTAL INCIDENCIAS', value: `${totalLateCount} retardos`, color: [255, 122, 0] },
    { label: 'HORAS EXTRA TOTALES', value: durationLabel(totalOvertimeMinutes), color: [107, 114, 128] },
  ];

  cards.forEach((card, index) => {
    const cardX = 40 + index * (cardWidth + cardGap);
    
    // Draw background rounded rect
    doc.setFillColor(248, 249, 250);
    doc.roundedRect(cardX, cardY, cardWidth, cardHeight, 4, 4, 'F');

    // Draw left vertical accent line
    doc.setFillColor(card.color[0], card.color[1], card.color[2]);
    doc.rect(cardX, cardY, 4, cardHeight, 'F');

    // Print label
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(7.5);
    doc.setTextColor(107, 114, 128);
    doc.text(card.label, cardX + 12, cardY + 16);

    // Print value
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(11);
    doc.setTextColor(card.color[0], card.color[1], card.color[2]);
    doc.text(card.value, cardX + 12, cardY + 34);
  });

  // Table header & body
  const tableHeaders = [
    'No.', 'Colaborador', 'Días', 'Tiempo Trab.', 'Decimales',
    'Retardos', 'Min. Tarde', 'S. Temp.', 'H. Extra', 'Días Incom.'
  ];

  const tableBody = totals.map((row) => [
    row.employeeId,
    row.employeeName,
    row.days,
    durationLabel(row.workedMinutes),
    decimalHours(row.workedMinutes),
    row.lateCount,
    `${row.lateMinutes} min`,
    row.earlyLeaveCount,
    durationLabel(row.overtimeMinutes),
    row.incompleteDays,
  ]);

  autoTable(doc, {
    startY: 130,
    head: [tableHeaders],
    body: tableBody,
    styles: { font: 'helvetica', fontSize: 8, cellPadding: 5, textColor: [27, 31, 36] },
    headStyles: { fillColor: [27, 31, 36], textColor: 255 },
    alternateRowStyles: { fillColor: [248, 249, 250] },
    margin: { left: 40, right: 40 },
    didParseCell: function(data) {
      if (data.section === 'body') {
        // Highlight lateCount (column 5) if > 0
        if (data.column.index === 5 && Number(data.cell.raw) > 0) {
          data.cell.styles.textColor = [255, 122, 0];
          data.cell.styles.fontStyle = 'bold';
        }
        // Highlight incompleteDays (column 9) if > 0
        if (data.column.index === 9 && Number(data.cell.raw) > 0) {
          data.cell.styles.textColor = [239, 68, 68];
          data.cell.styles.fontStyle = 'bold';
        }
      }
    }
  });

  // Signature Block
  let signatureY = doc.lastAutoTable.finalY + 30;
  if (signatureY + 50 > 572) {
    doc.addPage();
    doc.setFillColor(27, 31, 36);
    doc.rect(0, 0, 792, 6, 'F');
    doc.setFillColor(255, 122, 0);
    doc.rect(0, 6, 792, 3, 'F');
    signatureY = 60;
  }

  doc.setDrawColor(229, 231, 235);
  doc.line(80, signatureY + 35, 280, signatureY + 35);
  doc.line(512, signatureY + 35, 712, signatureY + 35);

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8.5);
  doc.setTextColor(107, 114, 128);
  doc.text('Elaborado por (Recursos Humanos)', 180, signatureY + 47, { align: 'center' });
  doc.text('Autorizado por (Gerencia / Nómina)', 612, signatureY + 47, { align: 'center' });
  doc.text('ASISTO By ITZ | OIL & GAS — Reporte consolidado del periodo para procesamiento administrativo.', 396, signatureY + 65, { align: 'center' });
}

function drawEmployeePage(doc, { employeeId, employeeName, empRows, empTotal, range, schedule, device }) {
  const generatedAt = new Date();

  // Top accent bar Grafito + Naranja ITZ
  doc.setFillColor(27, 31, 36);
  doc.rect(0, 0, 792, 6, 'F');
  doc.setFillColor(255, 122, 0);
  doc.rect(0, 6, 792, 3, 'F');

  // Brand mark left
  drawAsistoPdfBrand(doc, 40, 22);

  // Header Left
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(14);
  doc.setTextColor(27, 31, 36);
  doc.text('REPORTE DE ASISTENCIA Y PUNTUALIDAD DETALLADO', 166, 35);

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9);
  doc.setTextColor(107, 114, 128);
  doc.text(`Colaborador: [${employeeId}] - ${employeeName}`, 166, 48);

  // Header Right
  doc.setFontSize(8.5);
  doc.text(`Generado: ${dateTimeLabel(generatedAt.toISOString())}`, 580, 35);
  doc.text(`Periodo: ${dateLabel(range.from)} al ${dateLabel(range.to)}`, 580, 48);

  // Divider line
  doc.setDrawColor(229, 231, 235);
  doc.line(40, 60, 752, 60);

  // 1. Period & Device Configuration Metadata Card (from x=40 to x=250, width 220)
  const metaX = 40;
  const metaY = 70;
  const metaWidth = 220;
  const metaHeight = 52;

  doc.setFillColor(248, 249, 250);
  doc.roundedRect(metaX, metaY, metaWidth, metaHeight, 4, 4, 'F');
  doc.setDrawColor(229, 231, 235);
  doc.roundedRect(metaX, metaY, metaWidth, metaHeight, 4, 4, 'S');

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(7.5);
  doc.setTextColor(27, 31, 36);
  doc.text('CONFIGURACIÓN DEL PERIODO', metaX + 10, metaY + 12);

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(7);
  doc.setTextColor(107, 114, 128);
  doc.text(`Biométrico IP: ${device.ip}:${device.port}`, metaX + 10, metaY + 23);
  doc.text(`Horario L-V: ${schedule.shiftStart} - ${schedule.shiftEnd}`, metaX + 10, metaY + 32);
  doc.text(`Horario Sáb: ${schedule.satShiftStart || '08:00'} - ${schedule.satShiftEnd || '13:00'}`, metaX + 10, metaY + 41);
  doc.text(`Tolerancia entrada: ${schedule.graceMinutes} min`, metaX + 120, metaY + 23);

  // 2. Employee KPIs Row (4 cards from x=276 to x=752, each width 110, gap 11)
  const cardWidth = 110;
  const cardHeight = 52;
  const cardY = 70;
  const cardGap = 11;
  const employeeCards = [
    { label: 'DÍAS LABORADOS', value: `${empTotal.days} días`, color: [16, 185, 129] },
    { label: 'HORAS TRABAJADAS', value: durationLabel(empTotal.workedMinutes), color: [27, 31, 36] },
    { label: 'INCIDENCIAS', value: `${empTotal.lateCount} (${empTotal.lateMinutes} min)`, color: [255, 122, 0] },
    { label: 'HORAS EXTRA', value: durationLabel(empTotal.overtimeMinutes), color: [107, 114, 128] },
  ];

  employeeCards.forEach((card, index) => {
    const cardX = 276 + index * (cardWidth + cardGap);
    
    // Draw background rounded rect
    doc.setFillColor(248, 249, 250);
    doc.roundedRect(cardX, cardY, cardWidth, cardHeight, 4, 4, 'F');

    // Draw left vertical accent line
    doc.setFillColor(card.color[0], card.color[1], card.color[2]);
    doc.rect(cardX, cardY, 3, cardHeight, 'F');

    // Print label
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(7.0);
    doc.setTextColor(107, 114, 128);
    doc.text(card.label, cardX + 10, cardY + 16);

    // Print value
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(10);
    doc.setTextColor(card.color[0], card.color[1], card.color[2]);
    doc.text(card.value, cardX + 10, cardY + 36);
  });

  // Table headers & mapping
  const tableHeaders = [
    'Fecha', 'Entrada', 'Salida', 'Tiempo Trab.', 'Retardo',
    'Min. Tarde', 'S. Temp.', 'Min. S. Temp.', 'H. Extra', 'Estado'
  ];

  const tableBody = empRows.map((row) => [
    dateLabel(row.dateKey),
    row.firstPunch ? timeLabel(row.firstPunch) : '-',
    row.lastPunch && !row.isIncomplete ? timeLabel(row.lastPunch) : '-',
    durationLabel(row.workedMinutes),
    row.isLate ? 'Sí' : 'No',
    row.isLate ? `${row.lateMinutes} min` : '0 min',
    row.isEarlyLeave ? 'Sí' : 'No',
    row.isEarlyLeave ? `${row.earlyLeaveMinutes} min` : '0 min',
    durationLabel(row.overtimeMinutes),
    row.status,
  ]);

  autoTable(doc, {
    startY: 132,
    head: [tableHeaders],
    body: tableBody,
    styles: { font: 'helvetica', fontSize: 7.5, cellPadding: 4, textColor: [27, 31, 36] },
    headStyles: { fillColor: [27, 31, 36], textColor: 255 },
    alternateRowStyles: { fillColor: [248, 249, 250] },
    margin: { left: 40, right: 40 },
    didParseCell: function(data) {
      if (data.section === 'body' && data.column.index === 9) { // index 9 is 'Estado'
        const status = data.cell.raw;
        if (status === 'Retardo') {
          data.cell.styles.textColor = [255, 122, 0];
          data.cell.styles.fontStyle = 'bold';
        } else if (status === 'Salida Temprana' || status.includes('Temprana')) {
          data.cell.styles.textColor = [107, 114, 128];
          data.cell.styles.fontStyle = 'bold';
        } else if (status === 'Incompleto') {
          data.cell.styles.textColor = [239, 68, 68];
          data.cell.styles.fontStyle = 'bold';
        } else if (status === 'A tiempo' || status === 'Ok' || status === 'A tempo') {
          data.cell.styles.textColor = [16, 185, 129];
          data.cell.styles.fontStyle = 'bold';
        }
      }
    }
  });

  // Signature Block
  let signatureY = doc.lastAutoTable.finalY + 30;
  if (signatureY + 50 > 572) {
    doc.addPage();
    doc.setFillColor(27, 31, 36);
    doc.rect(0, 0, 792, 6, 'F');
    doc.setFillColor(255, 122, 0);
    doc.rect(0, 6, 792, 3, 'F');
    signatureY = 60;
  }

  doc.setDrawColor(229, 231, 235);
  doc.line(80, signatureY + 35, 280, signatureY + 35);
  doc.line(512, signatureY + 35, 712, signatureY + 35);

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8.5);
  doc.setTextColor(107, 114, 128);
  doc.text('Firma del Colaborador', 180, signatureY + 47, { align: 'center' });
  doc.text('Recursos Humanos / Autorización', 612, signatureY + 47, { align: 'center' });
  doc.text('ASISTO By ITZ | OIL & GAS — Registro oficial de asistencia y tiempos laborados para efectos de nómina.', 396, signatureY + 65, { align: 'center' });
}

function createPdf({ rows, totals, range, schedule, device, selectedEmployee, mode }) {
  if (selectedEmployee !== 'all') {
    const doc = new jsPDF({ orientation: 'landscape', unit: 'pt', format: 'letter' });
    const empTotal = totals[0];
    if (empTotal) {
      drawEmployeePage(doc, {
        employeeId: empTotal.employeeId,
        employeeName: empTotal.employeeName,
        empRows: rows,
        empTotal,
        range,
        schedule,
        device,
      });
      doc.save(`reporte-asistencia-${empTotal.employeeId}-${empTotal.employeeName.replace(/\s+/g, '_')}.pdf`);
    }
  } else if (mode === 'individual_files') {
    totals.forEach((empTotal, idx) => {
      setTimeout(() => {
        const doc = new jsPDF({ orientation: 'landscape', unit: 'pt', format: 'letter' });
        const empRows = rows.filter((r) => r.employeeId === empTotal.employeeId);
        drawEmployeePage(doc, {
          employeeId: empTotal.employeeId,
          employeeName: empTotal.employeeName,
          empRows,
          empTotal,
          range,
          schedule,
          device,
        });
        doc.save(`reporte-asistencia-${empTotal.employeeId}-${empTotal.employeeName.replace(/\s+/g, '_')}.pdf`);
      }, idx * 600);
    });
  } else {
    // Consolidated report: Page 1 is the summary page, Page 2+ are the individual detail pages!
    const doc = new jsPDF({ orientation: 'landscape', unit: 'pt', format: 'letter' });
    
    // Page 1: Summary Page
    drawSummaryPage(doc, { totals, range, device });
    
    // Page 2+: Individual detail pages
    totals.forEach((empTotal) => {
      doc.addPage();
      const empRows = rows.filter((r) => r.employeeId === empTotal.employeeId);
      drawEmployeePage(doc, {
        employeeId: empTotal.employeeId,
        employeeName: empTotal.employeeName,
        empRows,
        empTotal,
        range,
        schedule,
        device,
      });
    });
    
    doc.save(`reporte-asistencia-consolidado-${range.from}_a_${range.to}.pdf`);
  }
}

export default App;
