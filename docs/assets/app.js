(() => {
  'use strict';

  const config = window.SATFINDER_CONFIG || {};
  const elements = {
    networkState: document.querySelector('.network-state'),
    networkStateText: document.querySelector('#networkState'),
    lastUpdated: document.querySelector('#lastUpdated'),
    projectSubtitle: document.querySelector('#projectSubtitle'),
    refreshButton: document.querySelector('#refreshButton'),
    stationSearch: document.querySelector('#stationSearch'),
    regionFilters: document.querySelector('#regionFilters'),
    stationList: document.querySelector('#stationList'),
    resultCount: document.querySelector('#resultCount'),
    errorBanner: document.querySelector('#errorBanner'),
    errorMessage: document.querySelector('#errorMessage'),
    selectionCard: document.querySelector('#selectionCard'),
    closeSelection: document.querySelector('#closeSelection'),
    selectedStatus: document.querySelector('#selectedStatus'),
    selectedName: document.querySelector('#selectedName'),
    selectedRegion: document.querySelector('#selectedRegion'),
    selectedArea: document.querySelector('#selectedArea'),
    selectedSatellite: document.querySelector('#selectedSatellite'),
    selectedCoordinates: document.querySelector('#selectedCoordinates'),
    metricTotal: document.querySelector('#metricTotal'),
    metricLatest: document.querySelector('#metricLatest'),
    metricTarget: document.querySelector('#metricTarget'),
    metricProgress: document.querySelector('#metricProgress'),
    metricRemaining: document.querySelector('#metricRemaining'),
    metricPackets: document.querySelector('#metricPackets'),
  };

  const state = {
    data: null,
    activeRegion: 'all',
    query: '',
    selectedKey: '',
    loading: false,
    requestId: 0,
  };

  const numberFormatter = new Intl.NumberFormat('th-TH');
  const percentFormatter = new Intl.NumberFormat('th-TH', { maximumFractionDigits: 0 });
  const dateFormatter = new Intl.DateTimeFormat('th-TH', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'Asia/Bangkok',
  });

  const stationColor = '#5ff0ad';
  const projectTarget = Math.max(1, Number(config.projectTargetStations) || 250);
  const snapshotUrl = String(config.dataUrl || 'data/stations.json');
  const cacheKey = 'satfinder-public-snapshot-v2';

  let map;
  let stationLayer;
  const markersByKey = new Map();

  function initializeMap() {
    if (!window.L) throw new Error('โหลดระบบแผนที่ไม่สำเร็จ');
    map = window.L.map('map', {
      zoomControl: false,
      preferCanvas: true,
      minZoom: 4,
      maxBounds: [[3.5, 94], [23, 110]],
      maxBoundsViscosity: 0.8,
      worldCopyJump: true,
      fadeAnimation: false,
      zoomAnimation: false,
      markerZoomAnimation: false,
    }).setView(config.defaultCenter || [13.7563, 100.5018], config.defaultZoom || 5);
    window.L.control.zoom({ position: 'bottomleft' }).addTo(map);
    window.L.tileLayer('https://basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
      attribution: '&copy; OpenStreetMap contributors &copy; CARTO',
      maxZoom: 19,
      keepBuffer: 4,
      updateWhenIdle: true,
    }).addTo(map);
    stationLayer = window.L.layerGroup().addTo(map);
    window.setTimeout(() => map.invalidateSize(false), 0);
  }

  function isValidPayload(payload) {
    return Boolean(payload?.ok && payload?.data && Array.isArray(payload.data.stations));
  }

  function readCachedPayload() {
    try {
      const payload = JSON.parse(window.localStorage.getItem(cacheKey) || 'null');
      return isValidPayload(payload) ? payload : null;
    } catch {
      return null;
    }
  }

  function cachePayload(payload) {
    try {
      window.localStorage.setItem(cacheKey, JSON.stringify(payload));
    } catch {
      // Private browsing and strict storage policies can disable localStorage.
    }
  }

  async function loadSnapshot(timeoutMs = 8_000) {
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(snapshotUrl, {
        cache: 'no-cache',
        credentials: 'omit',
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`โหลดข้อมูลไม่สำเร็จ (${response.status})`);
      const payload = await response.json();
      if (!isValidPayload(payload)) throw new Error('รูปแบบข้อมูลสถานีไม่ถูกต้อง');
      return payload;
    } catch (error) {
      if (error.name === 'AbortError') throw new Error('หมดเวลารอข้อมูลสถานี');
      throw error;
    } finally {
      window.clearTimeout(timer);
    }
  }

  function formatNumber(value) {
    return numberFormatter.format(Number(value) || 0);
  }

  function normalizedSearch(value) {
    return String(value || '').trim().toLocaleLowerCase('th');
  }

  function filteredStations() {
    if (!state.data) return [];
    return state.data.stations.filter((station) => {
      if (state.activeRegion !== 'all' && station.region !== state.activeRegion) return false;
      if (!state.query) return true;
      const haystack = [station.name, station.satellite, station.satDisplayName, station.region, station.version]
        .map(normalizedSearch)
        .join(' ');
      return haystack.includes(state.query);
    });
  }

  function createText(tagName, className, text) {
    const element = document.createElement(tagName);
    if (className) element.className = className;
    element.textContent = text;
    return element;
  }

  function popupContent(station) {
    const wrapper = document.createElement('div');
    wrapper.append(
      createText('div', 'popup-status', 'สถานีในโครงการ'),
      createText('div', 'popup-name', station.name),
      createText('div', 'popup-meta', `${station.region || 'ไม่ระบุพื้นที่'} · ${station.satellite || 'ไม่ระบุดาวเทียม'}`),
    );
    return wrapper;
  }

  function renderMap(stations) {
    if (!map || !stationLayer) return;
    stationLayer.clearLayers();
    markersByKey.clear();
    const bounds = [];
    for (const station of stations) {
      const latitude = Number(station.latitude);
      const longitude = Number(station.longitude);
      if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) continue;
      const marker = window.L.circleMarker([latitude, longitude], {
        radius: 6,
        weight: 1.5,
        color: stationColor,
        fillColor: stationColor,
        fillOpacity: 0.86,
      });
      marker.bindPopup(popupContent(station), { className: 'station-popup', closeButton: false });
      marker.on('click', () => selectStation(station.stationKey, false));
      marker.addTo(stationLayer);
      markersByKey.set(station.stationKey, marker);
      bounds.push([latitude, longitude]);
    }
    if (bounds.length && !state.selectedKey) {
      map.invalidateSize(false);
      map.fitBounds(bounds, { padding: [32, 32], maxZoom: 8, animate: false });
    }
  }

  function createStationButton(station) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `station-item${state.selectedKey === station.stationKey ? ' is-selected' : ''}`;
    button.dataset.key = station.stationKey;
    button.setAttribute('aria-label', `${station.name}, ${station.region || 'ไม่ระบุพื้นที่'}`);
    button.addEventListener('click', () => selectStation(station.stationKey, true));

    const signal = createText('span', 'station-signal', '');
    signal.setAttribute('aria-hidden', 'true');
    const copy = createText('span', 'station-copy', '');
    copy.append(
      createText('strong', '', station.name),
      createText('span', '', `${station.region || 'ไม่ระบุพื้นที่'} · ${station.satellite || 'ไม่ระบุดาวเทียม'}`),
    );
    button.append(signal, copy);
    return button;
  }

  function renderStationList(stations) {
    elements.stationList.replaceChildren();
    elements.resultCount.textContent = `${formatNumber(stations.length)} สถานี`;
    if (!stations.length) {
      const empty = createText('div', 'empty-state', 'ไม่พบสถานีที่ตรงกับตัวกรอง');
      elements.stationList.append(empty);
      return;
    }
    const fragment = document.createDocumentFragment();
    stations.forEach((station) => fragment.append(createStationButton(station)));
    elements.stationList.append(fragment);
  }

  function renderMetrics(summary) {
    const total = Number(summary.totalStations) || 0;
    const progress = Math.min(100, total / projectTarget * 100);
    const remaining = Math.max(0, projectTarget - total);
    elements.metricTotal.textContent = formatNumber(total);
    elements.metricLatest.textContent = `ครอบคลุม ${formatNumber(summary.withLocation || total)} จุดบนแผนที่`;
    elements.metricTarget.textContent = formatNumber(projectTarget);
    elements.metricProgress.textContent = `${percentFormatter.format(progress)}%`;
    elements.metricRemaining.textContent = remaining
      ? `อีก ${formatNumber(remaining)} สถานี สู่เป้าหมาย`
      : 'บรรลุเป้าหมายโครงการแล้ว';
    elements.metricPackets.textContent = formatNumber(summary.confirmedPackets);
  }

  function renderFilters() {
    const stations = filteredStations();
    renderStationList(stations);
    renderMap(stations);
  }

  function selectedStation() {
    return state.data?.stations.find((station) => station.stationKey === state.selectedKey);
  }

  function selectStation(stationKey, moveMap) {
    state.selectedKey = stationKey;
    const station = selectedStation();
    if (!station) return closeSelection();
    elements.selectionCard.hidden = false;
    elements.selectedStatus.textContent = 'สถานีในโครงการ';
    elements.selectedName.textContent = station.name;
    elements.selectedRegion.textContent = `${station.region || 'ไม่ระบุพื้นที่'} · ${station.satellite || 'ไม่ระบุดาวเทียม'}`;
    elements.selectedArea.textContent = station.region || 'ไม่ระบุพื้นที่';
    elements.selectedSatellite.textContent = station.satellite || 'ไม่ระบุดาวเทียม';
    const latitude = Number(station.latitude);
    const longitude = Number(station.longitude);
    elements.selectedCoordinates.textContent = Number.isFinite(latitude) && Number.isFinite(longitude)
      ? `${latitude.toFixed(3)}, ${longitude.toFixed(3)}`
      : 'ไม่ระบุพิกัด';
    document.querySelectorAll('.station-item').forEach((item) => {
      item.classList.toggle('is-selected', item.dataset.key === stationKey);
    });
    const marker = markersByKey.get(stationKey);
    if (marker) {
      if (moveMap) map.setView(marker.getLatLng(), Math.max(map.getZoom(), 8), { animate: false });
      marker.openPopup();
    }
  }

  function closeSelection() {
    state.selectedKey = '';
    elements.selectionCard.hidden = true;
    if (map) map.closePopup();
    document.querySelectorAll('.station-item.is-selected').forEach((item) => item.classList.remove('is-selected'));
  }

  function showError(error) {
    elements.networkState.classList.remove('is-live', 'is-cached');
    elements.networkState.classList.add('is-error');
    elements.networkStateText.textContent = 'การเชื่อมต่อมีปัญหา';
    elements.errorMessage.textContent = error.message || 'โปรดลองใหม่อีกครั้ง';
    elements.errorBanner.hidden = false;
  }

  function showLive(importDate) {
    elements.networkState.classList.remove('is-error', 'is-cached');
    elements.networkState.classList.add('is-live');
    elements.networkStateText.textContent = 'ข้อมูลพร้อมใช้งาน';
    elements.lastUpdated.dateTime = importDate?.toISOString() || '';
    elements.lastUpdated.textContent = importDate ? `ข้อมูล ${dateFormatter.format(importDate)}` : '';
    elements.errorBanner.hidden = true;
  }

  function showCached(importDate) {
    elements.networkState.classList.remove('is-live', 'is-error');
    elements.networkState.classList.add('is-cached');
    elements.networkStateText.textContent = 'แสดงข้อมูลสำรองล่าสุด';
    elements.lastUpdated.dateTime = importDate?.toISOString() || '';
    elements.lastUpdated.textContent = importDate ? `ข้อมูล ${dateFormatter.format(importDate)}` : '';
    elements.errorBanner.hidden = true;
  }

  function payloadImportDate(payload) {
    const value = payload?.data?.config?.lastImportAt;
    if (!value) return null;
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  function applyPayload(payload) {
    state.data = payload.data;
    renderMetrics(payload.data.summary || {});
    renderFilters();
    elements.projectSubtitle.textContent = 'โครงการส่งเสริมการเรียนรู้ทางด้านโทรคมนาคมในโรงเรียนทั่วประเทศ';
  }

  async function refreshData() {
    if (state.loading) return;
    state.loading = true;
    state.requestId += 1;
    const requestId = state.requestId;
    elements.refreshButton.disabled = true;
    elements.refreshButton.classList.add('is-loading');
    if (!state.data) elements.networkStateText.textContent = 'กำลังโหลดข้อมูลสถานี';
    try {
      const payload = await loadSnapshot();
      if (requestId !== state.requestId) return;
      applyPayload(payload);
      cachePayload(payload);
      showLive(payloadImportDate(payload));
    } catch (error) {
      if (state.data) {
        showCached(payloadImportDate({ data: state.data }));
      } else {
        showError(error);
        elements.stationList.replaceChildren(createText('div', 'empty-state', 'ยังไม่มีข้อมูลสถานีให้แสดง'));
      }
    } finally {
      state.loading = false;
      elements.refreshButton.disabled = false;
      elements.refreshButton.classList.remove('is-loading');
    }
  }

  elements.refreshButton.addEventListener('click', refreshData);
  elements.closeSelection.addEventListener('click', closeSelection);
  elements.stationSearch.addEventListener('input', (event) => {
    state.query = normalizedSearch(event.target.value);
    closeSelection();
    renderFilters();
  });
  elements.regionFilters.addEventListener('click', (event) => {
    const button = event.target.closest('button[data-region]');
    if (!button) return;
    state.activeRegion = button.dataset.region;
    elements.regionFilters.querySelectorAll('button').forEach((item) => {
      item.setAttribute('aria-pressed', String(item === button));
    });
    closeSelection();
    renderFilters();
  });

  try {
    initializeMap();
  } catch (error) {
    const mapElement = document.querySelector('#map');
    mapElement.classList.add('map-unavailable');
    mapElement.replaceChildren(createText('p', '', 'แผนที่ไม่พร้อมใช้งานชั่วคราว แต่ข้อมูลสถานียังแสดงได้ตามปกติ'));
  }

  const cachedPayload = readCachedPayload();
  if (cachedPayload) {
    applyPayload(cachedPayload);
    showCached(payloadImportDate(cachedPayload));
  }
  refreshData();
  window.setInterval(refreshData, Math.max(30_000, Number(config.refreshIntervalMs) || 900_000));
})();
