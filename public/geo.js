/* ParentFirst — country / state / city pickers.
 *
 * Typed-in place names were making a mess: "bengaluru", "Bangalore", "B'lore"
 * are three cities as far as the database is concerned. So places are chosen,
 * not typed — with one honest escape hatch ("Not listed") for everywhere the
 * list misses, because a form that can't accept a real address is worse than
 * an untidy one.
 *
 * India is spelled out fully (that's where the parents are). Other countries
 * carry their top-level divisions where the list is short and stable; below
 * that the city is typed. Loaded before app.js; exposes window.PFGeo.
 */
(function (root) {
  'use strict';

  var INDIA = {
    'Andaman & Nicobar Islands': ['Port Blair'],
    'Andhra Pradesh': ['Visakhapatnam', 'Vijayawada', 'Guntur', 'Nellore', 'Kurnool', 'Rajahmundry', 'Tirupati', 'Kakinada', 'Kadapa', 'Anantapur'],
    'Arunachal Pradesh': ['Itanagar', 'Naharlagun', 'Pasighat'],
    'Assam': ['Guwahati', 'Silchar', 'Dibrugarh', 'Jorhat', 'Nagaon', 'Tinsukia', 'Tezpur'],
    'Bihar': ['Patna', 'Gaya', 'Bhagalpur', 'Muzaffarpur', 'Darbhanga', 'Purnia', 'Ara', 'Begusarai'],
    'Chandigarh': ['Chandigarh'],
    'Chhattisgarh': ['Raipur', 'Bhilai', 'Bilaspur', 'Korba', 'Durg', 'Rajnandgaon'],
    'Dadra & Nagar Haveli and Daman & Diu': ['Daman', 'Silvassa', 'Diu'],
    'Delhi': ['New Delhi', 'Delhi', 'Dwarka', 'Rohini', 'Saket', 'Karol Bagh', 'Pitampura', 'Vasant Kunj'],
    'Goa': ['Panaji', 'Margao', 'Vasco da Gama', 'Mapusa', 'Ponda'],
    'Gujarat': ['Ahmedabad', 'Surat', 'Vadodara', 'Rajkot', 'Bhavnagar', 'Jamnagar', 'Gandhinagar', 'Junagadh', 'Anand', 'Bharuch'],
    'Haryana': ['Gurugram', 'Faridabad', 'Panipat', 'Ambala', 'Karnal', 'Hisar', 'Rohtak', 'Sonipat', 'Yamunanagar'],
    'Himachal Pradesh': ['Shimla', 'Dharamshala', 'Solan', 'Mandi', 'Kullu', 'Manali'],
    'Jammu & Kashmir': ['Srinagar', 'Jammu', 'Anantnag', 'Baramulla', 'Udhampur'],
    'Jharkhand': ['Ranchi', 'Jamshedpur', 'Dhanbad', 'Bokaro', 'Deoghar', 'Hazaribagh'],
    'Karnataka': ['Bengaluru', 'Mysuru', 'Hubballi', 'Mangaluru', 'Belagavi', 'Davangere', 'Ballari', 'Kalaburagi', 'Shivamogga', 'Tumakuru', 'Udupi'],
    'Kerala': ['Thiruvananthapuram', 'Kochi', 'Kozhikode', 'Thrissur', 'Kollam', 'Alappuzha', 'Kannur', 'Palakkad', 'Kottayam'],
    'Ladakh': ['Leh', 'Kargil'],
    'Lakshadweep': ['Kavaratti'],
    'Madhya Pradesh': ['Indore', 'Bhopal', 'Jabalpur', 'Gwalior', 'Ujjain', 'Sagar', 'Satna', 'Rewa', 'Ratlam'],
    'Maharashtra': ['Mumbai', 'Pune', 'Nagpur', 'Nashik', 'Thane', 'Aurangabad', 'Solapur', 'Kolhapur', 'Amravati', 'Navi Mumbai', 'Sangli', 'Jalgaon'],
    'Manipur': ['Imphal', 'Thoubal'],
    'Meghalaya': ['Shillong', 'Tura'],
    'Mizoram': ['Aizawl', 'Lunglei'],
    'Nagaland': ['Kohima', 'Dimapur'],
    'Odisha': ['Bhubaneswar', 'Cuttack', 'Rourkela', 'Berhampur', 'Sambalpur', 'Puri', 'Balasore'],
    'Puducherry': ['Puducherry', 'Karaikal', 'Yanam'],
    'Punjab': ['Ludhiana', 'Amritsar', 'Jalandhar', 'Patiala', 'Bathinda', 'Mohali', 'Pathankot', 'Hoshiarpur'],
    'Rajasthan': ['Jaipur', 'Jodhpur', 'Udaipur', 'Kota', 'Ajmer', 'Bikaner', 'Bhilwara', 'Alwar', 'Sikar', 'Pali'],
    'Sikkim': ['Gangtok', 'Namchi'],
    'Tamil Nadu': ['Chennai', 'Coimbatore', 'Madurai', 'Tiruchirappalli', 'Salem', 'Tirunelveli', 'Erode', 'Vellore', 'Thoothukudi', 'Thanjavur'],
    'Telangana': ['Hyderabad', 'Warangal', 'Nizamabad', 'Karimnagar', 'Khammam', 'Secunderabad'],
    'Tripura': ['Agartala', 'Udaipur'],
    'Uttar Pradesh': ['Lucknow', 'Kanpur', 'Ghaziabad', 'Agra', 'Varanasi', 'Meerut', 'Prayagraj', 'Noida', 'Bareilly', 'Aligarh', 'Moradabad', 'Gorakhpur', 'Mathura'],
    'Uttarakhand': ['Dehradun', 'Haridwar', 'Roorkee', 'Haldwani', 'Rishikesh', 'Nainital'],
    'West Bengal': ['Kolkata', 'Howrah', 'Durgapur', 'Asansol', 'Siliguri', 'Bardhaman', 'Malda', 'Kharagpur']
  };

  var US = ['Alabama', 'Alaska', 'Arizona', 'Arkansas', 'California', 'Colorado', 'Connecticut', 'Delaware',
    'District of Columbia', 'Florida', 'Georgia', 'Hawaii', 'Idaho', 'Illinois', 'Indiana', 'Iowa', 'Kansas',
    'Kentucky', 'Louisiana', 'Maine', 'Maryland', 'Massachusetts', 'Michigan', 'Minnesota', 'Mississippi',
    'Missouri', 'Montana', 'Nebraska', 'Nevada', 'New Hampshire', 'New Jersey', 'New Mexico', 'New York',
    'North Carolina', 'North Dakota', 'Ohio', 'Oklahoma', 'Oregon', 'Pennsylvania', 'Rhode Island',
    'South Carolina', 'South Dakota', 'Tennessee', 'Texas', 'Utah', 'Vermont', 'Virginia', 'Washington',
    'West Virginia', 'Wisconsin', 'Wyoming'];

  // country -> { state: [cities] }  |  country -> [states]  |  country absent -> both typed
  var REGIONS = {
    'India': INDIA,
    'United States': US,
    'Canada': ['Alberta', 'British Columbia', 'Manitoba', 'New Brunswick', 'Newfoundland and Labrador',
      'Nova Scotia', 'Ontario', 'Prince Edward Island', 'Quebec', 'Saskatchewan',
      'Northwest Territories', 'Nunavut', 'Yukon'],
    'Australia': ['Australian Capital Territory', 'New South Wales', 'Northern Territory', 'Queensland',
      'South Australia', 'Tasmania', 'Victoria', 'Western Australia'],
    'United Kingdom': ['England', 'Scotland', 'Wales', 'Northern Ireland'],
    'United Arab Emirates': ['Abu Dhabi', 'Dubai', 'Sharjah', 'Ajman', 'Umm Al Quwain', 'Ras Al Khaimah', 'Fujairah'],
    'Singapore': ['Central', 'East', 'North', 'North-East', 'West'],
    'New Zealand': ['Auckland', 'Canterbury', 'Wellington', 'Waikato', 'Otago', 'Bay of Plenty', 'Manawatu-Whanganui', 'Northland', 'Hawke’s Bay', 'Taranaki', 'Southland', 'Nelson', 'Marlborough', 'Tasman', 'Gisborne', 'West Coast']
  };

  // India first — that is where the people being cared for almost always are.
  var COUNTRIES = ['India', 'United States', 'United Arab Emirates', 'United Kingdom', 'Canada',
    'Australia', 'Singapore', 'New Zealand', '───────────',
    'Afghanistan', 'Argentina', 'Austria', 'Bahrain', 'Bangladesh', 'Belgium', 'Bhutan', 'Brazil',
    'Cambodia', 'Chile', 'China', 'Colombia', 'Denmark', 'Egypt', 'Ethiopia', 'Fiji', 'Finland',
    'France', 'Germany', 'Ghana', 'Greece', 'Hong Kong', 'Hungary', 'Indonesia', 'Iran', 'Iraq',
    'Ireland', 'Israel', 'Italy', 'Japan', 'Jordan', 'Kenya', 'Kuwait', 'Malaysia', 'Maldives',
    'Mauritius', 'Mexico', 'Morocco', 'Myanmar', 'Nepal', 'Netherlands', 'Nigeria', 'Norway',
    'Oman', 'Pakistan', 'Philippines', 'Poland', 'Portugal', 'Qatar', 'Russia', 'Saudi Arabia',
    'South Africa', 'South Korea', 'Spain', 'Sri Lanka', 'Sweden', 'Switzerland', 'Taiwan',
    'Tanzania', 'Thailand', 'Turkey', 'Uganda', 'Ukraine', 'Vietnam', 'Zambia', 'Zimbabwe'];

  var OTHER = '__other__';
  var SEP = '───────────';

  function statesOf(country) {
    var r = REGIONS[country];
    if (!r) return null;
    return Array.isArray(r) ? r.slice() : Object.keys(r).sort();
  }
  function citiesOf(country, state) {
    var r = REGIONS[country];
    if (!r || Array.isArray(r)) return null;
    return r[state] ? r[state].slice() : null;
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  // <select> whose options are `list`, with `value` preselected even when the
  // list has never heard of it (an address typed before the picker existed).
  function select(name, list, value, placeholder, allowOther) {
    var known = list.indexOf(value) >= 0;
    var h = '<select class="geo-sel" data-geo="' + name + '">';
    h += '<option value=""' + (value ? '' : ' selected') + '>' + esc(placeholder) + '</option>';
    list.forEach(function (o) {
      if (o === SEP) { h += '<option disabled>' + esc(SEP) + '</option>'; return; }
      h += '<option value="' + esc(o) + '"' + (o === value ? ' selected' : '') + '>' + esc(o) + '</option>';
    });
    if (value && !known) h += '<option value="' + esc(value) + '" selected>' + esc(value) + '</option>';
    if (allowOther) h += '<option value="' + OTHER + '">Not listed — let me type it</option>';
    h += '</select>';
    return h;
  }

  function textInput(name, value, placeholder) {
    return '<input class="geo-sel" data-geo="' + name + '" type="text" value="' + esc(value || '')
      + '" placeholder="' + esc(placeholder) + '">';
  }

  // Render the three fields into `host` (a DOM element) for the given values.
  // Re-rendered on every change — small enough that this stays simple.
  function render(host, v) {
    v = v || {};
    var country = v.country || 'India';
    var states = statesOf(country);
    var h = '';

    h += '<label class="dl-label">Country</label>' + select('country', COUNTRIES, country, 'Choose a country', false);

    if (v._countryOther || (country && !states && country !== 'India')) {
      // a country we hold no divisions for — state and city are typed
      h += '<label class="dl-label">State / Province</label>' + textInput('state', v.state, 'e.g. Bavaria');
      h += '<label class="dl-label">City</label>' + textInput('city', v.city, 'e.g. Munich');
    } else {
      h += '<label class="dl-label">State</label>';
      h += v._stateOther
        ? textInput('state', v.state, 'Type the state')
        : select('state', states || [], v.state, 'Choose a state', true);

      var cities = v._stateOther ? null : citiesOf(country, v.state);
      h += '<label class="dl-label">City</label>';
      h += (cities && !v._cityOther)
        ? select('city', cities, v.city, v.state ? 'Choose a city' : 'Choose a state first', true)
        : textInput('city', v.city, 'Type the city');
    }
    host.innerHTML = h;

    host.querySelectorAll('[data-geo]').forEach(function (el) {
      el.addEventListener('change', function () {
        var next = read(host);
        if (el.tagName === 'SELECT' && el.value === OTHER) {
          // "Not listed" swaps that field for a text box and clears what follows
          next[el.dataset.geo] = '';
          if (el.dataset.geo === 'state') { next._stateOther = true; next.city = ''; }
          if (el.dataset.geo === 'city') next._cityOther = true;
        } else if (el.dataset.geo === 'country') {
          next.state = ''; next.city = ''; next._stateOther = false; next._cityOther = false;
        } else if (el.dataset.geo === 'state') {
          next.city = ''; next._cityOther = false;
        }
        render(host, next);
      });
    });
  }

  // Current values, carrying the "typed it myself" flags forward.
  function read(host) {
    var out = {
      _stateOther: !!(host.__geoState && host.__geoState._stateOther),
      _cityOther: !!(host.__geoState && host.__geoState._cityOther)
    };
    host.querySelectorAll('[data-geo]').forEach(function (el) {
      out[el.dataset.geo] = el.value === OTHER ? '' : (el.value || '').trim();
      if (el.tagName === 'INPUT' && el.dataset.geo === 'state') out._stateOther = true;
      if (el.tagName === 'INPUT' && el.dataset.geo === 'city') out._cityOther = true;
    });
    host.__geoState = out;
    return out;
  }

  // Just the three values, for sending to the server.
  function value(host) {
    var v = read(host);
    return { country: v.country || null, state: v.state || null, city: v.city || null };
  }

  root.PFGeo = {
    COUNTRIES: COUNTRIES, REGIONS: REGIONS,
    statesOf: statesOf, citiesOf: citiesOf,
    render: render, read: read, value: value
  };
})(window);
