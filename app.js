/**
 * Flight Simulator Application
 *
 * Handles simulation logic, map display, PFD, charts, and user interaction
 * for flying between selectable airport pairs loaded from routes.json.
 */
document.addEventListener('DOMContentLoaded', () => {

    // --- Configuration & Constants ---

    // File Path
    const ROUTES_JSON_URL = 'routes.json'; // Path to the routes data file

    // Unit Conversion Factors
    const KTS_TO_KPH = 1.852;
    const FT_TO_M = 0.3048;
    const NM_TO_KM = 1.852;
    const M_TO_FT = 1 / FT_TO_M;
    const KPH_TO_KTS = 1 / KTS_TO_KPH;
    const FPM_TO_MPM = FT_TO_M; // ft/min to m/min

    // Simulation Timing & Parameters
    const SIMULATION_INTERVAL = 100; // ms (10 updates per second)
    const CHART_MAX_POINTS = 120;    // Limit chart history (e.g., 2 minutes)
    const TAKEOFF_MIN_DIST_KM = 0.2; // Min distance (km) flown before sequencing past origin
    const TAKEOFF_MIN_SPEED_KTS = 50;  // Min speed (knots) before sequencing past origin

    // Physics Parameters (Using standard aviation units internally: ft, kts, ft/min, degrees/sec)
    const PHYSICS_PARAMS = {
        climbRate: 1800,        // ft/min
        descentRate: 1500,      // ft/min
        acceleration: 5,        // knots/sec
        deceleration: 7,        // knots/sec
        turnRate: 3,            // degrees/sec
        waypointCaptureDistance: 3, // nautical miles (distance to consider waypoint 'reached')
        // Landing thresholds (using metric for comparison against converted state values)
        landingAltitudeThresholdM: 300, // meters - Start checking below this altitude near destination
        landingSpeedThresholdKph: 260, // km/h - Considered landed if speed is below this near ground
        landingFinalAltitudeM: 30,      // meters - Considered 'on ground' if altitude is below this
        landingProximityKm: 2.0         // km - Check landing conditions when within this distance
    };

    // PFD Scaling (Pixels per DISPLAYED unit - calculated from base internal unit scaling)
    const PFD_BASE_SCALING = { pixelsPerKnot: 1.0, pixelsPerFoot: 0.2, pixelsPerDegree: 4 };
    const PFD_DISPLAY_SCALING = {
        speedTapePixelsPerKph: PFD_BASE_SCALING.pixelsPerKnot / KTS_TO_KPH,
        altitudeTapePixelsPerMeter: PFD_BASE_SCALING.pixelsPerFoot / FT_TO_M,
        headingTapePixelsPerDegree: PFD_BASE_SCALING.pixelsPerDegree,
        vsiMaxDisplayRateMpm: 600, // Max rate (+/- 600 m/min) for full scale deflection
        vsiMaxAngle: 45           // degrees needle deflection for max rate
    };

    // --- State Variables ---
    let availableRoutes = [];      // Holds data loaded from routes.json
    let selectedRouteIndex = 0;    // Index of the active route in availableRoutes
    let simState = {};             // Holds the current simulation state (initialized later)
    let simulationTimer = null;    // Interval timer for the simulation loop
    let totalRouteDistance = 0;    // Total distance of the selected route (KM)
    let flownDistance = 0;         // Accumulated flown distance (KM)

    // Map & Chart Objects
    let map = null;
    let plannedRoutePolyline = null;
    let flownPathPolyline = null;
    let aircraftMarker = null;
    let originMarker = null;
    let destMarker = null;
    let altitudeSpeedChart = null;
    let forcesChart = null;
    let chartData = { labels: [], altitude: [], speed: [], lift: [], drag: [], thrust: [] }; // Chart data uses metric display units

    // --- DOM Elements References ---
    const bodyElement = document.body;
    const routeSelector = document.getElementById('route-selector');
    const flightTitle = document.getElementById('flight-title');
    const infoRouteOrigin = document.getElementById('info-route-origin');
    const infoRouteDest = document.getElementById('info-route-dest');
    const autopilotButton = document.getElementById('autopilot-toggle');
    const resetButton = document.getElementById('reset-button');
    const altitudeSlider = document.getElementById('target-altitude');
    const speedSlider = document.getElementById('target-speed');
    const altitudeValueDisplay = document.getElementById('target-altitude-value');
    const speedValueDisplay = document.getElementById('target-speed-value');
    const infoCard = document.getElementById('info-card');
    const infoCardCloseButton = document.getElementById('info-card-close');
    const infoCardToggle = document.getElementById('info-card-toggle');
    const darkModeToggle = document.getElementById('dark-mode-toggle');
    const pfdSpeedValue = document.getElementById('current-speed-value');
    const pfdAltitudeValue = document.getElementById('current-altitude-value');
    const pfdHeadingValue = document.getElementById('current-heading-value');
    const pfdVsiValue = document.getElementById('current-vsi-value');
    const speedScale = document.querySelector('.speed-scale');
    const altitudeScale = document.querySelector('.altitude-scale');
    const headingScale = document.querySelector('.heading-scale');
    const vsiNeedle = document.querySelector('.vsi-needle');
    const infoStatus = document.getElementById('info-status');
    const infoPosition = document.getElementById('info-position');
    const infoAltitude = document.getElementById('info-altitude');
    const infoSpeed = document.getElementById('info-speed');
    const infoHeading = document.getElementById('info-heading');
    const infoVsi = document.getElementById('info-vsi');
    const infoTotalDist = document.getElementById('info-total-distance');
    const infoFlownDist = document.getElementById('info-flown-distance');
    const infoRemainDist = document.getElementById('info-remaining-distance');
    const infoNextWpt = document.getElementById('info-next-wpt');
    const infoEta = document.getElementById('info-eta');
    const infoWind = document.getElementById('info-wind');

    // --- Initialization ---
    async function init() {
        console.log("Initializing Simulator...");
        try {
            // 1. Load route data (essential before proceeding)
            await loadRoutes();

            // 2. Setup core components
            initDarkMode(); // Apply theme based on preference/storage
            setupMap();     // Create map, layers, markers
            setupCharts();  // Create chart instances

            // 3. Setup UI Interactions (populate selector, add listeners)
            setupUI();

            // 4. Select initial route (updates map, calculates distance, resets state)
            // Pass true to prevent double-resetting (resetSimulationState called inside)
            selectRoute(selectedRouteIndex, true);

            // 5. Perform initial UI draw based on the freshly reset state
            if (simState) updateUI(simState, 0);

            console.log("Simulator Ready.");

        } catch (error) {
            console.error("Initialization Failed:", error);
            // Display error to user
            const controlsContainer = document.querySelector('.card-body'); // Target the controls card body
            if (controlsContainer) {
                controlsContainer.innerHTML = `<p class="text-danger text-center small">Error initializing simulator.<br>Failed to load routes from ${ROUTES_JSON_URL}.<br>Please check the file exists and the console (F12) for details.</p>`;
            } else {
                 alert(`Simulator initialization failed: ${error.message}. Check console (F12).`);
            }
        }
    }

    // --- Data Loading ---
    async function loadRoutes() {
        console.log("Loading routes from:", ROUTES_JSON_URL);
        try {
            const response = await fetch(ROUTES_JSON_URL);
            if (!response.ok) {
                throw new Error(`HTTP error! Status: ${response.status} (${response.statusText})`);
            }
            availableRoutes = await response.json();
            if (!Array.isArray(availableRoutes) || availableRoutes.length === 0) {
                throw new Error("Route data is invalid or empty.");
            }
            selectedRouteIndex = 0; // Default to the first route
            console.log("Routes loaded successfully:", availableRoutes.length);
        } catch (error) {
            console.error("Failed to load or parse routes:", error);
            availableRoutes = [];
            selectedRouteIndex = -1; // Indicate no valid route selected
            throw error; // Propagate error to init
        }
    }

    // --- Route Selection ---
    function selectRoute(index, isInitialLoad = false) {
        if (index < 0 || index >= availableRoutes.length) {
            console.error("Invalid route index selected:", index);
            if (routeSelector) routeSelector.value = selectedRouteIndex; // Revert UI if invalid
            return;
        }

        // Only proceed if the index actually changes or on initial load
        if (index === selectedRouteIndex && !isInitialLoad) {
            return; // No change needed
        }

        selectedRouteIndex = index;
        const currentRoute = availableRoutes[selectedRouteIndex];
        console.log(`Selected Route: ${currentRoute.origin.iata} -> ${currentRoute.destination.iata}`);

        // 1. Update Route Info Display
        updateRouteDisplay();

        // 2. Calculate Distance for the new route
        calculateTotalRouteDistance();

        // 3. Reset Simulation State (uses the new selectedRouteIndex)
        resetSimulationState();

        // 4. Update Map Elements for the new route
        updateMapForRoute();

        // 5. Update the entire UI based on the new reset state
        if (simState) updateUI(simState, 0);
    }

    function updateRouteDisplay() {
        const currentRoute = availableRoutes[selectedRouteIndex];
        if (!currentRoute) return;
        const originIata = currentRoute.origin.iata;
        const destIata = currentRoute.destination.iata;

        if (flightTitle) flightTitle.innerHTML = `${originIata} <i class="fa-solid fa-plane-departure"></i> ${destIata} Flight Simulator`;
        if (infoRouteOrigin) infoRouteOrigin.textContent = originIata;
        if (infoRouteDest) infoRouteDest.textContent = destIata;
    }

    // --- Dark Mode ---
    function initDarkMode() {
        const prefersDark = window.matchMedia?.('(prefers-color-scheme: dark)').matches;
        const savedMode = localStorage.getItem('darkMode');
        const isDark = savedMode === 'enabled' || (!savedMode && prefersDark);

        bodyElement.classList.toggle('dark-mode', isDark);
        if (darkModeToggle) darkModeToggle.checked = isDark;
    }

    function toggleDarkMode() {
        bodyElement.classList.toggle('dark-mode');
        localStorage.setItem('darkMode', bodyElement.classList.contains('dark-mode') ? 'enabled' : 'disabled');
        updateChartTheme(); // Update charts after toggling class
    }

    function updateChartTheme() {
        const isDarkMode = bodyElement.classList.contains('dark-mode');
        const gridColor = isDarkMode ? 'rgba(255, 255, 255, 0.1)' : 'rgba(0, 0, 0, 0.1)';
        const labelColor = isDarkMode ? 'rgba(255, 255, 255, 0.7)' : '#666';
        const titleColor = isDarkMode ? 'rgba(255, 255, 255, 0.9)' : '#444';
        const tooltipBgColor = isDarkMode ? 'rgba(50, 50, 50, 0.9)' : 'rgba(0, 0, 0, 0.8)';
        const tooltipTextColor = '#fff';

        const updateOptions = (chart) => {
            if (!chart?.options) return; // Guard
            try {
                chart.options.plugins.legend.labels.color = labelColor;
                chart.options.plugins.tooltip.backgroundColor = tooltipBgColor;
                chart.options.plugins.tooltip.titleColor = tooltipTextColor;
                chart.options.plugins.tooltip.bodyColor = tooltipTextColor;

                Object.values(chart.options.scales).forEach(axis => {
                    if (axis) {
                        if (axis.ticks) axis.ticks.color = labelColor;
                        if (axis.grid) axis.grid.color = gridColor;
                        if (axis.title) axis.title.color = titleColor;
                    }
                });
                chart.update('none');
            } catch (e) { console.error("Error updating chart theme:", e); }
        };
        updateOptions(altitudeSpeedChart);
        updateOptions(forcesChart);
    }

    // --- Setup Functions ---
    function setupMap() {
        if (map) map.remove(); // Ensure previous map instance is removed
        map = L.map('map', { attributionControl: false }); // Disable default attribution, add custom later
        L.control.attribution({ position: 'bottomleft', prefix: false }).addTo(map); // Add custom with no prefix

        L.tileLayer('https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png', {
             attribution: '© <a href="https://osm.org/copyright" target="_blank">OSM</a> | © <a href="https://carto.com/attributions" target="_blank">CARTO</a>',
             subdomains: 'abcd', maxZoom: 19 // Reduced maxZoom slightly
        }).addTo(map);

        // Initialize layers/markers (positions set later)
        plannedRoutePolyline = L.polyline([], { color: 'blue', weight: 2, opacity: 0.7, dashArray: '5, 10' }).addTo(map);
        flownPathPolyline = L.polyline([], { color: 'red', weight: 3, opacity: 0.8 }).addTo(map);
        originMarker = L.marker([0,0], { icon: L.divIcon({ className: 'fa-solid fa-plane-departure fa-2x', iconSize: [20, 20], html: '' }) }).addTo(map);
        destMarker = L.marker([0,0], { icon: L.divIcon({ className: 'fa-solid fa-plane-arrival fa-2x', iconSize: [20, 20], html: '' }) }).addTo(map);
        const aircraftIcon = L.divIcon({ html: '<i class="fa-solid fa-plane aircraft-icon"></i>', className: '', iconSize: [24, 24], iconAnchor: [12, 12] });
        aircraftMarker = L.marker([0, 0], { icon: aircraftIcon, rotationAngle: 0, rotationOrigin: 'center center' }).addTo(map);
    }

    function setupCharts() {
        if (altitudeSpeedChart) altitudeSpeedChart.destroy();
        if (forcesChart) forcesChart.destroy();

        const commonChartOptions = {
            responsive: true, maintainAspectRatio: false, animation: false,
            plugins: { legend: { labels: {} }, tooltip: {} },
            scales: { x: { ticks:{}, grid:{}, title:{ display: true, text: 'Time (s)'} }}
       };

       const altSpeedCtx = document.getElementById('altitudeSpeedChart')?.getContext('2d');
       if (altSpeedCtx) {
           altitudeSpeedChart = new Chart(altSpeedCtx, {
               type: 'line',
               data: { labels: [], datasets: [ { label: 'Altitude (m)', data: [], borderColor: 'rgb(75, 192, 192)', tension: 0.1, yAxisID: 'yAltitude' }, { label: 'Speed (km/h)', data: [], borderColor: 'rgb(255, 99, 132)', tension: 0.1, yAxisID: 'ySpeed' } ] },
               options: { ...commonChartOptions, scales: { ...commonChartOptions.scales, yAltitude: { type: 'linear', position: 'left', title: { display: true, text: 'Altitude (m)' }, beginAtZero: false, ticks:{}, grid:{} }, ySpeed: { type: 'linear', position: 'right', title: { display: true, text: 'Speed (km/h)' }, beginAtZero: false, grid: { drawOnChartArea: false }, ticks:{} } } }
           });
       } else { console.error("Altitude/Speed Chart canvas not found"); }

       const forcesCtx = document.getElementById('forcesChart')?.getContext('2d');
       if (forcesCtx) {
           forcesChart = new Chart(forcesCtx, {
               type: 'line',
               data: { labels: [], datasets: [ { label: 'Lift', data: [], borderColor: 'rgb(54, 162, 235)', tension: 0.1 }, { label: 'Drag', data: [], borderColor: 'rgb(255, 159, 64)', tension: 0.1 }, { label: 'Thrust', data: [], borderColor: 'rgb(153, 102, 255)', tension: 0.1 } ] },
               options: { ...commonChartOptions, scales: { ...commonChartOptions.scales, y: { title: { display: true, text: 'Relative Force' }, beginAtZero: true, suggestedMax: 1.5, ticks:{}, grid:{} } } }
           });
       } else { console.error("Forces Chart canvas not found"); }

       updateChartTheme(); // Apply theme after creation
    }

    function setupUI() {
        // Populate Route Selector
        if (routeSelector) {
            routeSelector.innerHTML = ''; // Clear placeholder
            if (availableRoutes.length > 0 && selectedRouteIndex >= 0) {
                availableRoutes.forEach((route, index) => {
                    const option = document.createElement('option');
                    option.value = index;
                    const originNameShort = route.origin.name.split(' Airport')[0].split(' International')[0];
                    const destNameShort = route.destination.name.split(' Airport')[0].split(' International')[0];
                    option.textContent = `${route.origin.iata} (${originNameShort}) → ${route.destination.iata} (${destNameShort})`;
                    routeSelector.appendChild(option);
                });
                routeSelector.value = selectedRouteIndex; // Set initial selection
                routeSelector.disabled = false;
                routeSelector.addEventListener('change', (e) => {
                    selectRoute(parseInt(e.target.value), false); // Pass false for subsequent selections
                });
            } else {
                 routeSelector.innerHTML = '<option disabled>No routes available</option>';
                 routeSelector.disabled = true;
            }
        } else { console.warn("Route selector element not found."); }

        // Add other listeners (with null checks)
        autopilotButton?.addEventListener('click', toggleAutopilot);
        resetButton?.addEventListener('click', resetSimulation);
        altitudeSlider?.addEventListener('input', handleAltitudeSlider);
        speedSlider?.addEventListener('input', handleSpeedSlider);
        infoCardCloseButton?.addEventListener('click', () => infoCard?.classList.add('hidden'));
        infoCardToggle?.addEventListener('change', (e) => infoCard?.classList.toggle('hidden', !e.target.checked));
        darkModeToggle?.addEventListener('change', toggleDarkMode);

        // Update display from initial slider values (if they exist)
        if (altitudeSlider && altitudeValueDisplay) altitudeValueDisplay.textContent = altitudeSlider.value;
        if (speedSlider && speedValueDisplay) speedValueDisplay.textContent = speedSlider.value;
    }

    // --- State Management ---
    function resetSimulationState() {
         stopSimulation(); // Ensure timer is cleared first
         const currentRoute = availableRoutes[selectedRouteIndex];
         if (!currentRoute) {
             console.error("Cannot reset: No valid route selected or availableRoutes empty.");
             // Handle this case - maybe disable controls?
             simState = {}; // Clear state
             return;
         }

         const originCoords = [currentRoute.origin.coordinates.latitude, currentRoute.origin.coordinates.longitude];
         const destCoords = [currentRoute.destination.coordinates.latitude, currentRoute.destination.coordinates.longitude];
         const initialBearing = getBearing(originCoords[0], originCoords[1], destCoords[0], destCoords[1]);

         // Initialize simState object
         simState = {
             lat: originCoords[0], lon: originCoords[1],
             altitude: 50, // Start low (internal feet)
             targetAltitude: parseFloat(altitudeSlider?.value || '3000') * M_TO_FT,
             targetSpeed: parseFloat(speedSlider?.value || '400') * KPH_TO_KTS,
             speed: 0, heading: initialBearing, verticalSpeed: 0,
             autopilotOn: false, currentWaypointIndex: 0, // 0 = Origin, 1 = Destination
             simulationTime: 0, status: "Idle",
             windSpeed: Math.round(Math.random() * 30 + 5), windDirection: Math.round(Math.random() * 360),
             originCoords: originCoords, destCoords: destCoords
         };
         flownDistance = 0; // Reset KM

         // Reset Map Elements
         if (aircraftMarker) {
             aircraftMarker.setLatLng(originCoords).setRotationAngle(simState.heading);
         }
         if (flownPathPolyline) flownPathPolyline.setLatLngs([]);

         // Reset charts data
         chartData = { labels: [], altitude: [], speed: [], lift: [], drag: [], thrust: [] };
         if (altitudeSpeedChart?.data) { altitudeSpeedChart.data.labels = chartData.labels; altitudeSpeedChart.data.datasets[0].data = chartData.altitude; altitudeSpeedChart.data.datasets[1].data = chartData.speed; altitudeSpeedChart.update('none'); }
         if (forcesChart?.data) { forcesChart.data.labels = chartData.labels; forcesChart.data.datasets[0].data = chartData.lift; forcesChart.data.datasets[1].data = chartData.drag; forcesChart.data.datasets[2].data = chartData.thrust; forcesChart.update('none'); }

         updateAutopilotButtonState(); // Reflect AP off state
         console.log(`Simulation state reset for route ${currentRoute.origin.iata}-${currentRoute.destination.iata}`);
     }

    // Updates map markers, polyline, and view based on the current route
    function updateMapForRoute() {
        const currentRoute = availableRoutes[selectedRouteIndex];
        if (!currentRoute || !map || !originMarker || !destMarker || !plannedRoutePolyline) return;

        const originCoords = [currentRoute.origin.coordinates.latitude, currentRoute.origin.coordinates.longitude];
        const destCoords = [currentRoute.destination.coordinates.latitude, currentRoute.destination.coordinates.longitude];
        const originPopup = `${currentRoute.origin.iata}<br>${currentRoute.origin.name}`; // More info in popup
        const destPopup = `${currentRoute.destination.iata}<br>${currentRoute.destination.name}`;

        originMarker.setLatLng(originCoords).bindPopup(originPopup);
        destMarker.setLatLng(destCoords).bindPopup(destPopup);

        const routePoints = [originCoords, destCoords];
        plannedRoutePolyline.setLatLngs(routePoints);

        // Add a check for valid bounds before fitting
        const bounds = L.latLngBounds(routePoints);
        if (bounds.isValid()) {
            map.fitBounds(bounds.pad(0.15));
        } else {
             console.warn("Could not fit map bounds for the selected route.");
             map.setView(originCoords, 5); // Fallback view
        }
    }

    // --- Simulation Loop & Core Logic ---
    function simulationLoop() {
        if (!simState?.autopilotOn) return; // Check if state exists and AP is on
        if (simState.status === "Landed" || simState.status === "Crashed") { stopSimulation(); return; }

        const dt = SIMULATION_INTERVAL / 1000;
        simState.simulationTime += dt;

        // Update state
        updateAltitude(dt);
        updateSpeed(dt);
        updateHeading(dt); // Steers towards destination (index 1) if currentWaypointIndex is 1
        const { groundSpeed, track } = calculateWindEffect(simState.heading, simState.speed, simState.windDirection, simState.windSpeed);
        updatePosition(dt, groundSpeed, track);
        updateFlownDistance();

        // Check conditions
        checkLanding(); // Check landing first, might change status
        if (simState.status === "Landed" || simState.status === "Crashed") { stopSimulation(); return; } // Re-check status
        checkWaypointArrival(); // Check if takeoff complete

        // Update UI
        updateUI(simState, groundSpeed);
    }

    // --- Physics/Navigation/Distance Functions ---
    // (updateAltitude, updateSpeed, updateHeading, calculateWindEffect, updatePosition, updateFlownDistance - implementations unchanged)
    function updateAltitude(dt) { if(!simState) return; const altDiffFt = simState.targetAltitude - simState.altitude; let targetVSI = 0; if (Math.abs(altDiffFt) > 10) targetVSI = (altDiffFt > 0) ? PHYSICS_PARAMS.climbRate : -PHYSICS_PARAMS.descentRate; let vsiDiff = targetVSI - simState.verticalSpeed; simState.verticalSpeed += vsiDiff * 0.1; simState.altitude += (simState.verticalSpeed / 60) * dt; simState.altitude = Math.max(0, simState.altitude); }
    function updateSpeed(dt) { if(!simState) return; const speedDiffKts = simState.targetSpeed - simState.speed; let accel = 0; if (Math.abs(speedDiffKts) > 1) { accel = (speedDiffKts > 0) ? PHYSICS_PARAMS.acceleration : -PHYSICS_PARAMS.deceleration; let speedChange = accel * dt; if (Math.abs(speedChange) > Math.abs(speedDiffKts)) speedChange = speedDiffKts; simState.speed += speedChange; } simState.speed = Math.max(0, simState.speed); }
    function updateHeading(dt) { if(!simState || simState.currentWaypointIndex !== 1 /* Only steer towards dest */) return; const targetCoords = simState.destCoords; if(!targetCoords) return; const targetBearing = getBearing(simState.lat, simState.lon, targetCoords[0], targetCoords[1]); let headingDiff = targetBearing - simState.heading; while (headingDiff <= -180) headingDiff += 360; while (headingDiff > 180) headingDiff -= 360; const maxTurn = PHYSICS_PARAMS.turnRate * dt; const turn = Math.max(-maxTurn, Math.min(maxTurn, headingDiff)); simState.heading += turn; simState.heading = (simState.heading + 360) % 360; }
    function calculateWindEffect(h, s, wd, ws) { const hr=degreesToRadians(h); const wr=degreesToRadians(wd); const vax=s*Math.sin(hr); const vay=s*Math.cos(hr); const wx=ws*Math.sin(wr); const wy=ws*Math.cos(wr); const gx=vax+wx; const gy=vay+wy; const gs=Math.sqrt(gx*gx+gy*gy); let tk=radiansToDegrees(Math.atan2(gx,gy)); tk=(tk+360)%360; return{groundSpeed:gs, track:tk};}
    function updatePosition(dt, gs, trk) { if(!simState) return; const dnm=gs*(dt/3600); if(dnm<=0) return; const {lat,lon}=calculateNewPosition(simState.lat, simState.lon, trk, dnm); simState.lat=lat; simState.lon=lon;}
    function updateFlownDistance() { if (!flownPathPolyline || !simState) return; const currentLatLng = L.latLng(simState.lat, simState.lon); const pathPoints = flownPathPolyline.getLatLngs(); if (pathPoints.length > 0) { const prev = pathPoints[pathPoints.length - 1]; try { const distM = currentLatLng.distanceTo(prev); flownDistance += distM / 1000; } catch(e){console.warn("Error calculating distance:", e)}} flownPathPolyline.addLatLng(currentLatLng); }

    // --- Condition Checks ---
    // (checkWaypointArrival, checkLanding - implementations unchanged)
    function checkWaypointArrival() { if (!simState || simState.currentWaypointIndex !== 0 || !simState.autopilotOn) return; if (simState.speed > TAKEOFF_MIN_SPEED_KTS && flownDistance > TAKEOFF_MIN_DIST_KM) { console.log("Sequencing past Origin -> Destination"); simState.currentWaypointIndex = 1; simState.status = "En Route"; } }
    function checkLanding() { if (!simState || simState.currentWaypointIndex !== 1 || simState.status === "Landed" || simState.status === "Crashed") return; const distanceToDestNM = getDistance(simState.lat, simState.lon, simState.destCoords[0], simState.destCoords[1]); const distanceToDestKm = distanceToDestNM * NM_TO_KM; const altM = simState.altitude * FT_TO_M; const spdKph = simState.speed * KTS_TO_KPH; if (distanceToDestKm < PHYSICS_PARAMS.landingProximityKm && altM < PHYSICS_PARAMS.landingAltitudeThresholdM) { if (simState.status !== "Landing Soon") simState.status = "Landing Soon"; } else if (distanceToDestKm < PHYSICS_PARAMS.waypointCaptureDistance * NM_TO_KM * 2 && simState.status === "En Route") { simState.status = "Approaching"; } if (simState.status === "Landing Soon" && altM < PHYSICS_PARAMS.landingFinalAltitudeM) { if (spdKph < PHYSICS_PARAMS.landingSpeedThresholdKph) { simState.status = "Landed"; } else { console.warn(`Landed too fast! ${spdKph.toFixed(0)} km/h`); simState.status = "Crashed"; } simState.autopilotOn = false; } }


    // --- UI Update Functions (Display Metric) ---
    // (updateUI, updatePFDDisplay, updateInfoCard, updateCharts - implementations unchanged)
    function updateUI(state, groundSpeedKnots) { if (!state || !aircraftMarker) return; aircraftMarker.setLatLng([state.lat, state.lon]); aircraftMarker.setRotationAngle(state.heading); updatePFDDisplay(state); updateInfoCard(state, groundSpeedKnots); updateCharts(state); }
    function updatePFDDisplay(state) { if (!state) return; const spdKph=state.speed*KTS_TO_KPH; const altM=state.altitude*FT_TO_M; const vsiMpm=state.verticalSpeed*FPM_TO_MPM; const spdOfs=-(spdKph*PFD_DISPLAY_SCALING.speedTapePixelsPerKph); const altOfs=-(altM*PFD_DISPLAY_SCALING.altitudeTapePixelsPerMeter); const hdgOfs=-(state.heading*PFD_DISPLAY_SCALING.headingTapePixelsPerDegree); if(speedScale)speedScale.style.transform=`translateY(${spdOfs}px)`; if(altitudeScale)altitudeScale.style.transform=`translateY(${altOfs}px)`; if(headingScale)headingScale.style.transform=`translateX(${hdgOfs}px)`; if(pfdSpeedValue)pfdSpeedValue.textContent=Math.round(spdKph); if(pfdAltitudeValue)pfdAltitudeValue.textContent=Math.round(altM); if(pfdHeadingValue)pfdHeadingValue.textContent=Math.round(state.heading).toString().padStart(3,'0'); if(pfdVsiValue)pfdVsiValue.textContent=Math.round(vsiMpm); if(vsiNeedle){const clamp=Math.max(-PFD_DISPLAY_SCALING.vsiMaxDisplayRateMpm, Math.min(PFD_DISPLAY_SCALING.vsiMaxDisplayRateMpm, vsiMpm)); const angle=(clamp/PFD_DISPLAY_SCALING.vsiMaxDisplayRateMpm)*PFD_DISPLAY_SCALING.vsiMaxAngle; vsiNeedle.style.transform=`translateY(-50%) rotate(${angle}deg)`;}}
    function updateInfoCard(state, gsKts) { if (!state || !infoStatus || !availableRoutes[selectedRouteIndex]) return; const altM=state.altitude*FT_TO_M; const gsKph=gsKts*KTS_TO_KPH; const vsiMpm=state.verticalSpeed*FPM_TO_MPM; const wndKph=state.windSpeed*KTS_TO_KPH; const remKm=Math.max(0,totalRouteDistance-flownDistance); const currentRoute = availableRoutes[selectedRouteIndex]; infoStatus.textContent=state.status; infoPosition.textContent=`${state.lat.toFixed(4)} N, ${state.lon.toFixed(4)} E`; infoAltitude.textContent=`${Math.round(altM)}`; infoSpeed.textContent=`${Math.round(gsKph)}`; infoHeading.textContent=`${Math.round(state.heading)}°`; infoVsi.textContent=`${Math.round(vsiMpm)}`; infoTotalDist.textContent=`${totalRouteDistance.toFixed(1)}`; infoFlownDist.textContent=`${flownDistance.toFixed(1)}`; infoRemainDist.textContent=`${remKm.toFixed(1)}`; if(state.currentWaypointIndex === 0) infoNextWpt.textContent = currentRoute.origin.iata; else if (state.currentWaypointIndex === 1) infoNextWpt.textContent = currentRoute.destination.iata; if (state.status === "Landed" || state.status === "Crashed") infoNextWpt.textContent = "Arrived"; let eta="--:--:--"; if(gsKph>20&&remKm>0.1&&state.status!=="Landed"&&state.status!=="Crashed"){const hrs=remKm/gsKph;const secs=Math.round(hrs*3600);if(secs<86400*2){const h=Math.floor(secs/3600);const m=Math.floor((secs%3600)/60);const s=secs%60;eta=`${h.toString().padStart(2,'0')}:${m.toString().padStart(2,'0')}:${s.toString().padStart(2,'0')}`;}}else if(state.status==="Landed"||state.status==="Crashed")eta="Arrived"; infoEta.textContent=eta; infoWind.textContent=`${Math.round(state.windDirection)}° @ ${Math.round(wndKph)} km/h`; }
    function updateCharts(state) { if (!altitudeSpeedChart || !forcesChart || !state) return; const altM=state.altitude*FT_TO_M; const spdKph=state.speed*KTS_TO_KPH; const tgtSpdKts=state.targetSpeed>0?state.targetSpeed:1; const lift=Math.pow(state.speed/tgtSpdKts,2); const drag=lift*0.8+0.1; let thrust=0.5; if(state.speed<state.targetSpeed-1)thrust=1.0; if(state.altitude<state.targetAltitude-10)thrust=1.2; if(state.speed>state.targetSpeed+1)thrust=0.2; chartData.labels.push(Math.round(state.simulationTime)); chartData.altitude.push(Math.round(altM)); chartData.speed.push(Math.round(spdKph)); chartData.lift.push(lift.toFixed(2)); chartData.drag.push(drag.toFixed(2)); chartData.thrust.push(thrust.toFixed(2)); while(chartData.labels.length>CHART_MAX_POINTS){chartData.labels.shift(); chartData.altitude.shift(); chartData.speed.shift(); chartData.lift.shift(); chartData.drag.shift(); chartData.thrust.shift();} try { altitudeSpeedChart.update('none'); forcesChart.update('none'); } catch (e) { console.error("Error updating charts:", e); } }


    // --- Event Handlers ---
    function toggleAutopilot() { /* (Unchanged) */ if (!simState || simState.status === "Landed" || simState.status === "Crashed") return; simState.autopilotOn = !simState.autopilotOn; if (simState.autopilotOn) startSimulation(); else stopSimulation(); }
    function resetSimulation() { /* (Unchanged) */ console.log("UI: Reset Button Clicked"); selectRoute(selectedRouteIndex, false); } // Re-select the current route to trigger reset
    function handleAltitudeSlider(event) { /* (Unchanged) */ if (!simState || !altitudeValueDisplay) return; const targetMeters = parseInt(event.target.value); simState.targetAltitude = targetMeters * M_TO_FT; altitudeValueDisplay.textContent = targetMeters; }
    function handleSpeedSlider(event) { /* (Unchanged) */ if (!simState || !speedValueDisplay) return; const targetKph = parseInt(event.target.value); simState.targetSpeed = targetKph * KPH_TO_KTS; speedValueDisplay.textContent = targetKph; }
    function updateAutopilotButtonState() { /* (Unchanged) */ if (!autopilotButton || !resetButton || !simState) return; const disableEngage = simState.status === "Landed" || simState.status === "Crashed"; if (simState.autopilotOn) { autopilotButton.innerHTML = '<i class="fa-solid fa-pause"></i> Disengage AP'; autopilotButton.classList.remove('btn-primary'); autopilotButton.classList.add('btn-warning'); autopilotButton.disabled = false; resetButton.disabled = true; } else { autopilotButton.innerHTML = '<i class="fa-solid fa-play"></i> Engage AP'; autopilotButton.classList.remove('btn-warning'); autopilotButton.classList.add('btn-primary'); autopilotButton.disabled = disableEngage; resetButton.disabled = false; } }

    // --- Simulation Control ---
    function startSimulation() { /* (Unchanged) */ if (!simulationTimer && simState && simState.status !== "Landed" && simState.status !== "Crashed") { simState.status = simState.altitude * FT_TO_M < 50 ? "Takeoff / Climb" : "En Route"; console.log("Simulation Timer Started - Status:", simState.status); simState.autopilotOn = true; updateAutopilotButtonState(); updateInfoCard(simState, 0); simulationTimer = setInterval(simulationLoop, SIMULATION_INTERVAL); } }
    function stopSimulation() { /* (Unchanged) */ if (simulationTimer) { clearInterval(simulationTimer); simulationTimer = null; console.log("Simulation Timer Stopped."); } if (simState && simState.status !== "Landed" && simState.status !== "Crashed") { simState.autopilotOn = false; simState.status = "Paused"; } updateAutopilotButtonState(); if (simState) updateInfoCard(simState, 0); }

    // --- Helper Functions ---
    // (degreesToRadians, radiansToDegrees, getDistance (NM), getBearing (deg), calculateNewPosition (uses NM), calculateTotalRouteDistance (KM) - unchanged)
    function degreesToRadians(d) { return d * Math.PI / 180; }
    function radiansToDegrees(r) { return r * 180 / Math.PI; }
    function getDistance(lat1, lon1, lat2, lon2) { if (lat1 == lat2 && lon1 == lon2) return 0; const R=6371/NM_TO_KM; const dLat=degreesToRadians(lat2-lat1); const dLon=degreesToRadians(lon2-lon1); lat1=degreesToRadians(lat1); lat2=degreesToRadians(lat2); const a=Math.sin(dLat/2)**2+Math.cos(lat1)*Math.cos(lat2)*Math.sin(dLon/2)**2; const c=2*Math.atan2(Math.sqrt(a),Math.sqrt(1-a)); return R*c;}
    function getBearing(lat1, lon1, lat2, lon2) { lat1=degreesToRadians(lat1);lon1=degreesToRadians(lon1); lat2=degreesToRadians(lat2);lon2=degreesToRadians(lon2); const y=Math.sin(lon2-lon1)*Math.cos(lat2); const x=Math.cos(lat1)*Math.sin(lat2)-Math.sin(lat1)*Math.cos(lat2)*Math.cos(lon2-lon1); return(radiansToDegrees(Math.atan2(y,x))+360)%360;}
    function calculateNewPosition(lat, lon, bearing, dNM) { const R=6371/NM_TO_KM; const φ1=degreesToRadians(lat); const λ1=degreesToRadians(lon); const brng=degreesToRadians(bearing); const d=dNM; if(d===0)return{lat:lat,lon:lon}; const φ2=Math.asin(Math.sin(φ1)*Math.cos(d/R)+Math.cos(φ1)*Math.sin(d/R)*Math.cos(brng)); let λ2=λ1+Math.atan2(Math.sin(brng)*Math.sin(d/R)*Math.cos(φ1),Math.cos(d/R)-Math.sin(φ1)*Math.sin(φ2)); const lat2=radiansToDegrees(φ2); let lon2=radiansToDegrees(λ2); lon2=(lon2+540)%360-180; return{lat:lat2,lon:lon2};}
    function calculateTotalRouteDistance() { totalRouteDistance=0; const currentRoute=availableRoutes[selectedRouteIndex]; if(!currentRoute) return; const o=currentRoute.origin.coordinates; const d=currentRoute.destination.coordinates; totalRouteDistance = getDistance(o.latitude, o.longitude, d.latitude, d.longitude) * NM_TO_KM; console.log(`Selected route distance: ${totalRouteDistance.toFixed(1)} km`); if(infoTotalDist) infoTotalDist.textContent = totalRouteDistance.toFixed(1); }


    // --- Start Initialization ---
    init(); // Call the async init function

}); // End DOMContentLoaded