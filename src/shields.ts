import _ from 'lodash';

export function shieldsIO(params: { [key: string]: string }): string {
  const encodePair = (key: string, value: any) =>
    (_.isNumber(value) || !!value)
      ? (key + "=" + encodeURIComponent("" + value))
      : "";
  const query = Object.keys(params).map(key => {
    const value = params[key];
    return _.map(_.isArray(value) ? value : [value], elem => encodePair(key, elem));
  }).flat().filter(p => !!p).join("&");
  return "https://img.shields.io/static/v1?" + query;
}
